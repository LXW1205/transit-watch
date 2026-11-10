// Delay-based ETA for /api/route/:name/live, per the contract's "ETA method".
//
// For every live vehicle: snap it to each direction's shape, take the trip whose
// scheduled position is closest to now (i.e. the trip with the smallest |delay|),
// and then project that delay onto the stops ahead. The soonest ETA across live
// vehicles wins. Nothing is invented: a stale vehicle, an off-route vehicle and a
// vehicle with no plausible trip produce no numbers at all.
//
// Loop routes (T504/T505 are loops) return to their origin, so a point can project
// onto several segments of the same shape. No heading is available from the kiosk,
// so the projection is disambiguated by the timetable: the candidate whose implied
// delay is smallest is the bus that is actually there.
//
// Everything here is O(vehicles × candidates × trips) with interned patterns, so a
// poll costs tens of thousands of cheap operations — no per-request scan of 175k rows.

import { snapToShape, distAtProjection } from './gtfs.mjs';

const KL_OFFSET_MS = 8 * 60 * 60 * 1000;

// beyond this the bus is not on this route's shape at all
const MAX_SNAP_M = 250;
// segments within this of the nearest one are candidate projections (loop legs)
const SNAP_TOLERANCE_M = 150;
const MAX_CANDIDATES = 4;
// a trip further off than this is not the bus's trip; report no ETA instead
const MAX_DELAY_S = 45 * 60;

// ---------------------------------------------------------------- clock
// GTFS service times are seconds from midnight in Asia/Kuala_Lumpur, and may pass
// 24:00 for after-midnight trips. No DST here, so a fixed offset is exact.
export function klClock(nowMs = Date.now()) {
  const d = new Date(nowMs + KL_OFFSET_MS);
  const iso = d.toISOString();
  return {
    date: iso.slice(0, 10),
    seconds: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
  };
}

// ---------------------------------------------------------------- snapping
// A loop route passes the same point twice, and the kiosk sends no heading, so
// every segment within SNAP_TOLERANCE_M of the nearest becomes a candidate.
function candidatesFor(direction, lat, lng) {
  if (!direction.shape || direction.shape.length < 2) return [];
  const hits = snapToShape(direction.shape, lat, lng, SNAP_TOLERANCE_M);
  if (!hits.length || hits[0].distM > MAX_SNAP_M) return [];

  const out = [];
  for (const h of hits) {
    const dist = distAtProjection(direction.pointDist, h.index, h.t);
    // adjacent segments of one bend are one candidate, not several
    if (out.some((o) => Math.abs(o.dist - dist) < 0.05)) continue;
    out.push({ distM: h.distM, dist, index: h.index, t: h.t });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

// ---------------------------------------------------------------- schedule
// Scheduled time (seconds from service midnight) at a distance along the shape,
// interpolated between the surrounding stops.
function scheduledAt(trip, dist) {
  const stops = trip.pattern;
  const n = stops.dist.length;
  if (!n) return NaN;
  if (!(dist > stops.dist[0])) return trip.dep[0];

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (stops.dist[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= n - 1) return trip.arr[n - 1];

  const span = stops.dist[lo + 1] - stops.dist[lo];
  const f = span > 0 ? (dist - stops.dist[lo]) / span : 1;
  // dwell time at a stop is the departure; the vehicle is between stops here
  return trip.dep[lo] + f * (trip.arr[lo + 1] - trip.dep[lo]);
}

// Day offsets a trip's times may be measured from: today's service, or yesterday's
// when an after-midnight trip has stop times beyond 24:00.
function offsetsFor(serviceId, todayServices, yesterdayServices) {
  if (!todayServices && !yesterdayServices) return [0];
  const out = [];
  if (!todayServices || todayServices.has(serviceId)) out.push(0);
  if (yesterdayServices && yesterdayServices.has(serviceId)) out.push(86_400);
  return out;
}

// Trip whose scheduled position is closest to now → { trip, delayS, offset }.
function matchTrip(direction, dist, nowS, todayServices, yesterdayServices) {
  let best = null;
  for (const trip of direction.trips) {
    const offsets = offsetsFor(trip.serviceId, todayServices, yesterdayServices);
    if (!offsets.length) continue;
    const sched = scheduledAt(trip, dist);
    if (!Number.isFinite(sched)) continue;
    for (const offset of offsets) {
      const delayS = nowS - (sched + offset);
      if (Math.abs(delayS) > MAX_DELAY_S) continue;
      if (!best || Math.abs(delayS) < Math.abs(best.delayS)) best = { trip, delayS, offset };
    }
  }
  return best;
}

const NO_ESTIMATE = { directionId: null, progress: null, nextStop: null, bearing: null };

// Heading of travel at a shape segment, in degrees clockwise from north.
// The kiosk sends no heading, and a GPS-derived one is jittery at stops, so the
// route geometry is the stable source: the bus is following this line.
function segmentBearing(shape, index) {
  if (!shape || shape.length < 2) return null;
  for (let i = Math.max(0, index); i < shape.length - 1; i++) {
    const [aLat, aLng] = shape[i];
    const [bLat, bLng] = shape[i + 1];
    const dNorth = bLat - aLat;
    const dEast = (bLng - aLng) * Math.cos((aLat * Math.PI) / 180);
    if (Math.abs(dNorth) < 1e-9 && Math.abs(dEast) < 1e-9) continue;   // duplicate point
    return ((Math.atan2(dEast, dNorth) * 180) / Math.PI + 360) % 360;
  }
  return null;
}

// direction -> Map(stopId -> canonical stop); memoised, never mutating the model
const stopIndex = new WeakMap();
function stopsOf(direction) {
  let index = stopIndex.get(direction);
  if (!index) {
    index = new Map(direction.stops.map((s) => [s.stopId, s]));
    stopIndex.set(direction, index);
  }
  return index;
}

// ---------------------------------------------------------------- estimate
// Returns the per-direction stop ETAs and the per-vehicle direction/progress/next
// stop. Stop ETAs merge across live vehicles: soonest wins, whole minutes, >= 0.
export function estimateRoute(route, vehicles, { now = Date.now(), todayServices, yesterdayServices } = {}) {
  const { seconds: nowS } = klClock(now);
  const byDirection = new Map();   // dirId -> Map(stopId -> { etaMin, etaS })
  const estimates = new Map();     // busNo -> { directionId, progress, nextStop }

  for (const bus of vehicles) {
    // A vehicle that is not serving passengers (kiosk "off trip": layover,
    // deadheading) must never invent ETAs. It stays on the map, but it cannot be
    // "arriving" anywhere. This was also the source of the optimistic ETA at
    // terminals, where a bus waiting at the origin matched the next departure.
    const serving = bus.status !== 'off_trip';
    if (!bus.live || !serving || !Number.isFinite(bus.lat) || !Number.isFinite(bus.lng)) {
      estimates.set(bus.busNo, NO_ESTIMATE);
      continue;
    }

    let best = null;
    for (const direction of route.directions) {
      const stopsById = stopsOf(direction);
      for (const cand of candidatesFor(direction, bus.lat, bus.lng)) {
        const match = matchTrip(direction, cand.dist, nowS, todayServices, yesterdayServices);
        if (!match) continue;
        // smallest implied delay wins; within half a minute, the closer projection
        const spread = Math.abs(match.delayS);
        const better = !best
          || spread < best.spread - 30
          || (spread <= best.spread + 30 && cand.distM < best.distM);
        if (better) best = { direction, cand, spread, ...match };
      }
    }

    if (!best) {
      estimates.set(bus.busNo, NO_ESTIMATE);
      continue;
    }

    const { direction, cand, trip, delayS, offset } = best;
    const stopsById = stopsOf(direction);
    const pattern = trip.pattern;
    const etas = byDirection.get(direction.id) || new Map();
    byDirection.set(direction.id, etas);

    let nextStop = null;
    for (let i = 0; i < pattern.stopIds.length; i++) {
      const stop = stopsById.get(pattern.stopIds[i]);
      if (!stop) continue;
      if (pattern.dist[i] < cand.dist - 0.02) continue;      // already served
      const etaS = Math.max(0, trip.arr[i] + offset + delayS - nowS);
      const etaMin = Math.round(etaS / 60);
      const hit = etas.get(stop.stopId);
      if (!hit || etaS < hit.etaS) etas.set(stop.stopId, { etaS, etaMin });
      if (!nextStop) nextStop = { seq: stop.seq, stopId: stop.stopId, name: stop.name, etaMin };
    }

    const maxDist = direction.pointDist[direction.pointDist.length - 1] || 0;
    estimates.set(bus.busNo, {
      directionId: direction.id,
      progress: maxDist > 0 ? Math.min(1, Math.max(0, cand.dist / maxDist)) : null,
      nextStop,
      bearing: segmentBearing(direction.shape, cand.index),
    });
  }

  const directions = route.directions.map((direction) => {
    const etas = byDirection.get(direction.id);
    return {
      id: direction.id,
      headsign: direction.headsign,
      stops: direction.stops.map((s) => {
        const hit = etas?.get(s.stopId);
        return {
          seq: s.seq,
          stopId: s.stopId,
          name: s.name,
          lat: s.lat,
          lng: s.lng,
          etaMin: hit ? hit.etaMin : null,
          // same instant as etaMin, so the two columns can never disagree
          nextAt: hit ? new Date(now + hit.etaMin * 60_000).toISOString() : null,
        };
      }),
    };
  });

  return { directions, estimates };
}
