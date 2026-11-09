// GTFS static feed for the Prasarana MRT feeder network (data.gov.my).
//
// The zip is ~2 MB and 301-redirects to S3 — `fetch` follows that for us. The raw
// zip is cached in DATA_DIR; the calendar inside it rolls over roughly monthly, so a
// cached copy is only reused for a day. The CSVs are then parsed into the indexes
// built here: 175k stop_times rows become Int32Arrays of seconds-from-service-
// midnight, so the per-request ETA math interpolates without allocating per row.
//
// Loaded model:
//   { fetchedAt, validTo, zipPath,
//     routes:  Map<routeId, route>
//     byName:  Map<name, route>
//     services: Map<serviceId, service> }
//
//   route = { id, name, headsigns, stopCount, tripCount, directions }
//   direction = {
//     id,                            // GTFS direction_id
//     headsign, shapeId,
//     shape: [[lat, lng]],           // polyline, as served by /api/route
//     pointDist: [km],               // parallel to shape; GTFS shape_dist_traveled
//     stops: [{ seq, stopId, name, lat, lng, dist }],   // canonical trip order, dist in km
//     trips: [{ tripId, serviceId, serviceLabel, firstS, lastS, firstDeparture,
//               lastArrival, arr, dep, pattern }]
//   }
//   pattern = { stopIds: [], seq: [], dist: [km] }   // interned: most trips share one
//
// Established quirks of this feed (do not re-derive):
//   - the route name (T504) is in route_long_name; route_short_name is empty
//   - routes here are loops: they carry a single direction_id and a shape that
//     returns to its origin, so `directions` often has one entry
//   - stop_times.shape_dist_traveled and shapes.shape_dist_traveled are km and
//     share one frame, which is what makes progress/second interpolation cheap
//   - a stop's public id is its stop_code (SP398), not its numeric stop_id

import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

export const GTFS_URL = 'https://api.data.gov.my/gtfs-static/prasarana?category=rapid-bus-mrtfeeder';
export const ZIP_FILE = 'gtfs_rapid_bus_mrtfeeder.zip';

// the feed's calendar window is ~4 weeks; a day-old copy is still well inside it
const REFRESH_MS = 24 * 60 * 60 * 1000;
// refresh a little early rather than 404 on trips the day the window closes
const VALIDITY_MARGIN_DAYS = 3;

const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// ---------------------------------------------------------------- csv
// Line based: this feed never puts a newline inside a quoted field (only
// stop_headsign has commas, 1.5k rows). Quoted lines take the slow path.
function splitQuoted(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

export function* csvRows(text) {
  let first = true;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (first) { first = false; continue; }
    yield line.includes('"') ? splitQuoted(line) : line.split(',');
  }
}

function fileText(files, name) {
  const buf = files[name];
  return buf ? Buffer.from(buf).toString('utf8') : '';
}

// ---------------------------------------------------------------- geometry
const R_EARTH = 6371008.8;

function haversineM(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Segments of a polyline near a point, nearest first: [{ index, t, distM }].
// `toleranceM` also returns the segments a loop route traverses twice, which is
// what lets the ETA code tell a bus's outbound leg from its return leg.
// Local equirectangular metres are plenty at the scale of one bus route.
export function snapToShape(shape, lat, lng, toleranceM = 0) {
  const kx = Math.cos((lat * Math.PI) / 180) * 111320;
  const ky = 110540;
  const hits = [];
  let nearest = Infinity;

  for (let i = 0; i < shape.length - 1; i++) {
    const [aLat, aLng] = shape[i];
    const [bLat, bLng] = shape[i + 1];
    const ax = (aLng - lng) * kx, ay = (aLat - lat) * ky;
    const dx = (bLng - aLng) * kx, dy = (bLat - aLat) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const distM = Math.hypot(ax + t * dx, ay + t * dy);
    if (distM < nearest) nearest = distM;
    hits.push({ index: i, t, distM });
  }
  return hits.filter((h) => h.distM <= nearest + toleranceM).sort((a, b) => a.distM - b.distM);
}

const projectOnShape = (shape, lat, lng) => snapToShape(shape, lat, lng)[0] || null;

// Distance (km) along the shape at a projection, from shape_dist_traveled.
export function distAtProjection(pointDist, index, t) {
  const a = pointDist[index] ?? 0;
  const b = pointDist[index + 1] ?? a;
  return a + (b - a) * t;
}

// ---------------------------------------------------------------- time
export function clockToSeconds(clock) {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(String(clock || '').trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function secondsToClock(s) {
  const n = Math.max(0, Math.round(s));
  const hh = Math.floor(n / 3600);
  const mm = Math.floor((n % 3600) / 60);
  const ss = n % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

const fmtDate = (compact) => {
  const s = String(compact || '').trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- readers
function readStops(files) {
  const stops = new Map();
  for (const [id, code, name, lat, lng] of csvRows(fileText(files, 'stops.txt'))) {
    if (!id) continue;
    stops.set(id, {
      id,
      // the public id (SP398) is stop_code; stop_id is a numeric private key
      code: (code || '').trim() || id,
      name: (name || '').trim(),
      lat: Number(lat),
      lng: Number(lng),
    });
  }
  return stops;
}

function readServices(files) {
  const services = new Map();
  for (const row of csvRows(fileText(files, 'calendar.txt'))) {
    const id = (row[0] || '').trim();
    if (!id) continue;
    const days = WEEK.map((_, i) => row[i + 1] === '1');
    const start = fmtDate(row[8]);
    const end = fmtDate(row[9]);
    const weekdays = days.slice(0, 5).every(Boolean);
    const weekend = days[5] && days[6] && days.slice(0, 5).every(d => !d);
    const label = weekdays && !days[5] && !days[6] ? 'weekday'
      : weekend ? 'weekend'
        : days.every(Boolean) ? 'daily'
          : 'other';
    services.set(id, { id, days, start, end, label, exceptions: new Map() });
  }
  for (const [id, date, type] of csvRows(fileText(files, 'calendar_dates.txt'))) {
    const service = services.get((id || '').trim());
    if (service) service.exceptions.set(fmtDate(date), type === '1');
  }
  return services;
}

function readShapes(files) {
  const raw = new Map();
  for (const [id, lat, lng, seq, dist] of csvRows(fileText(files, 'shapes.txt'))) {
    if (!id) continue;
    let pts = raw.get(id);
    if (!pts) raw.set(id, pts = []);
    pts.push({ seq: Number(seq) || 0, lat: Number(lat), lng: Number(lng), dist: Number(dist) });
  }

  const shapes = new Map();
  for (const [id, pts] of raw) {
    pts.sort((a, b) => a.seq - b.seq);
    const shape = [];
    const pointDist = [];
    for (const p of pts) {
      const last = shape[shape.length - 1];
      // collapse repeated coordinates; keep the later distance
      if (last && last[0] === p.lat && last[1] === p.lng) { pointDist[pointDist.length - 1] = p.dist; continue; }
      shape.push([p.lat, p.lng]);
      pointDist.push(p.dist);
    }
    shapes.set(id, { shape, pointDist: normalizeDist(shape, pointDist) });
  }
  return shapes;
}

// shape_dist_traveled is present here, but fall back to cumulative metres if a
// shape's column is empty or not monotonic.
function normalizeDist(shape, dist) {
  let usable = shape.length > 1;
  for (let i = 0; i < shape.length && usable; i++) {
    if (!Number.isFinite(dist[i])) usable = false;
    else if (i > 0 && dist[i] < dist[i - 1]) usable = false;
  }
  if (usable) return dist;
  const out = [0];
  for (let i = 1; i < shape.length; i++) {
    out.push(out[i - 1] + haversineM(shape[i - 1][0], shape[i - 1][1], shape[i][0], shape[i][1]) / 1000);
  }
  return out;
}

function readStopTimes(files) {
  const byTrip = new Map();
  for (const [tripId, arr, dep, stopId, seq, , dist] of csvRows(fileText(files, 'stop_times.txt'))) {
    if (!tripId) continue;
    let t = byTrip.get(tripId);
    if (!t) byTrip.set(tripId, t = { ids: [], seq: [], arr: [], dep: [], dist: [] });
    t.ids.push(stopId);
    t.seq.push(Number(seq) || 0);
    t.arr.push(clockToSeconds(arr));
    t.dep.push(clockToSeconds(dep));
    t.dist.push(dist === '' || dist === undefined ? NaN : Number(dist));
  }
  // one pass of ordering; GTFS usually arrives sorted already
  for (const t of byTrip.values()) {
    const order = t.seq.map((_, i) => i).sort((a, b) => t.seq[a] - t.seq[b]);
    const sorted = { ids: [], seq: [], arr: [], dep: [], dist: [] };
    for (const i of order) {
      sorted.ids.push(t.ids[i]);
      sorted.seq.push(t.seq[i]);
      sorted.arr.push(t.arr[i]);
      sorted.dep.push(t.dep[i]);
      sorted.dist.push(t.dist[i]);
    }
    t.ids = sorted.ids; t.seq = sorted.seq; t.arr = sorted.arr; t.dep = sorted.dep; t.dist = sorted.dist;
  }
  return byTrip;
}

// ---------------------------------------------------------------- model
function buildModel(files, zipPath) {
  const stops = readStops(files);
  const services = readServices(files);
  const shapes = readShapes(files);
  const stopTimes = readStopTimes(files);

  const names = new Map();
  for (const [id, , short, long] of csvRows(fileText(files, 'routes.txt'))) {
    if (!id) continue;
    const name = ((long || '').trim() || (short || '').trim());
    if (name) names.set(id, name);
  }

  // route_id -> direction_id -> [trip]
  const stopsByCode = new Map();
  for (const stop of stops.values()) if (!stopsByCode.has(stop.code)) stopsByCode.set(stop.code, stop);

  const byRoute = new Map();
  for (const [routeId, serviceId, tripId, headsign, dirId, shapeId] of csvRows(fileText(files, 'trips.txt'))) {
    if (!routeId || !names.has(routeId)) continue;
    if (!stopTimes.has(tripId)) continue;   // a trip with no stop times is unusable
    let dirs = byRoute.get(routeId);
    if (!dirs) byRoute.set(routeId, dirs = new Map());
    const dir = String(dirId || '0').trim() || '0';
    let bucket = dirs.get(dir);
    if (!bucket) dirs.set(dir, bucket = []);
    bucket.push({
      tripId,
      serviceId: (serviceId || '').trim(),
      headsign: (headsign || '').trim(),
      shapeId: (shapeId || '').trim(),
    });
  }

  const routes = new Map();
  const byName = new Map();
  for (const [routeId, dirs] of byRoute) {
    const name = names.get(routeId);
    const directions = [];
    const headsigns = [];
    const stopIds = new Set();
    let tripCount = 0;

    for (const [dirKey, rawTrips] of dirs) {
      const direction = buildDirection(Number(dirKey), rawTrips, { stops, stopsByCode, shapes, stopTimes, services });
      if (!direction) continue;
      directions.push(direction);
      tripCount += direction.trips.length;
      if (!headsigns.includes(direction.headsign)) headsigns.push(direction.headsign);
      for (const s of direction.stops) stopIds.add(s.stopId);
    }
    if (!directions.length) continue;

    directions.sort((a, b) => a.id - b.id);
    const route = {
      id: routeId,
      name,
      headsigns,
      stopCount: stopIds.size,
      tripCount,
      directions,
    };
    routes.set(routeId, route);
    if (!byName.has(name)) byName.set(name, route);
  }

  let validTo = '';
  for (const s of services.values()) if (s.end > validTo) validTo = s.end;

  return {
    fetchedAt: new Date().toISOString(),
    validTo,
    zipPath,
    routes,
    byName,
    services,
    activeCache: new Map(),
  };
}

function buildDirection(dirId, rawTrips, { stops, stopsByCode, shapes, stopTimes, services }) {
  // Intern stop patterns: they repeat across a route's ~80 trips and the
  // Int32Arrays below are then enough to interpolate any trip. Stop ids are kept
  // as the public stop_code (SP398) — that is what the API serves and what the
  // ETA maths keys on.
  const patterns = new Map();
  const trips = [];

  for (const raw of rawTrips) {
    const st = stopTimes.get(raw.tripId);
    if (!st || !st.ids.length) continue;
    const key = st.ids.join(',');
    let pattern = patterns.get(key);
    if (!pattern) {
      pattern = {
        stopIds: st.ids.map((id) => stops.get(id)?.code || id),
        seq: st.seq.slice(),
        dist: st.dist.slice(),
      };
      patterns.set(key, pattern);
    }
    const firstS = st.dep[0];
    const lastS = st.arr[st.arr.length - 1];
    const trip = {
      tripId: raw.tripId,
      serviceId: raw.serviceId,
      serviceLabel: services.get(raw.serviceId)?.label || 'other',
      headsign: raw.headsign,
      shapeId: raw.shapeId,
      pattern,
      firstS,
      lastS,
      arr: Int32Array.from(st.arr, (v) => (Number.isFinite(v) ? v : 0)),
      dep: Int32Array.from(st.dep, (v) => (Number.isFinite(v) ? v : 0)),
    };
    trips.push(trip);
  }
  if (!trips.length) return null;

  trips.sort((a, b) => a.firstS - b.firstS || a.tripId.localeCompare(b.tripId));

  // Canonical trip: the longest stop list, so the served stops cover the route.
  let canonical = trips[0];
  for (const t of trips) if (t.pattern.stopIds.length > canonical.pattern.stopIds.length) canonical = t;

  const shapeId = canonical.shapeId || trips.find((t) => t.shapeId)?.shapeId || '';
  const geo = shapes.get(shapeId) || { shape: [], pointDist: [] };

  const pattern = canonical.pattern;
  const canonicalStops = pattern.stopIds.map((stopId, i) => {
    const stop = stopsByCode.get(stopId) || { code: stopId, name: '', lat: NaN, lng: NaN };
    let dist = pattern.dist[i];
    if (!Number.isFinite(dist) && geo.shape.length > 1) {
      const p = projectOnShape(geo.shape, stop.lat, stop.lng);
      dist = p ? distAtProjection(geo.pointDist, p.index, p.t) : NaN;
    }
    if (!Number.isFinite(dist)) dist = 0;
    return { seq: pattern.seq[i], stopId: stop.code, name: stop.name, lat: stop.lat, lng: stop.lng, dist };
  });

  // Serve the pattern's stop distances as plain arrays — the interned pattern
  // keeps only what the ETA math needs.
  trips.forEach((t) => {
    t.pattern = { stopIds: t.pattern.stopIds, seq: t.pattern.seq, dist: t.pattern.dist };
  });

  return {
    id: dirId,
    headsign: canonical.headsign || '',
    shapeId,
    shape: geo.shape,
    pointDist: geo.pointDist,
    stops: canonicalStops,
    trips: trips.map((t) => ({
      tripId: t.tripId,
      serviceId: t.serviceId,
      serviceLabel: t.serviceLabel,
      firstS: t.firstS,
      lastS: t.lastS,
      firstDeparture: secondsToClock(t.firstS),
      lastArrival: secondsToClock(t.lastS),
      arr: t.arr,
      dep: t.dep,
      pattern: t.pattern,
    })),
  };
}

// ---------------------------------------------------------------- services
// Which service ids run on a calendar date (Asia/Kuala_Lumpur). Cached per date:
// the live endpoint asks for today/yesterday on every poll.
export function servicesOn(model, dateStr) {
  const hit = model.activeCache.get(dateStr);
  if (hit) return hit;

  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();   // 0 = Sunday
  const dayIdx = (dow + 6) % 7;                              // 0 = Monday

  const active = new Set();
  for (const s of model.services.values()) {
    const exception = s.exceptions.get(dateStr);
    const runs = exception !== undefined
      ? exception
      : s.days[dayIdx] && dateStr >= s.start && dateStr <= s.end;
    if (runs) active.add(s.id);
  }

  if (model.activeCache.size > 8) model.activeCache.clear();
  model.activeCache.set(dateStr, active);
  return active;
}

// ---------------------------------------------------------------- loading
export function needsRefresh(model, now = Date.now()) {
  if (!model) return true;
  const age = now - Date.parse(model.fetchedAt);
  if (!(age < REFRESH_MS)) return true;
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);   // KL date
  return !model.validTo || model.validTo < addDays(today, VALIDITY_MARGIN_DAYS);
}

async function ensureZip(dataDir, log) {
  fs.mkdirSync(dataDir, { recursive: true });
  const zipPath = path.join(dataDir, ZIP_FILE);
  let age = Infinity;
  try { age = Date.now() - fs.statSync(zipPath).mtimeMs; } catch { /* no cache yet */ }
  if (age < REFRESH_MS) return zipPath;

  try {
    log(`gtfs: downloading ${GTFS_URL}`);
    const res = await fetch(GTFS_URL, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // a truncated or challenge page would unzip to nothing; fail before caching
    if (buf.length < 200_000) throw new Error(`suspiciously small feed (${buf.length} bytes)`);
    const tmp = `${zipPath}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, zipPath);
    log(`gtfs: cached ${(buf.length / 1e6).toFixed(1)} MB at ${zipPath}`);
    return zipPath;
  } catch (e) {
    if (age !== Infinity) {
      log(`gtfs: refresh failed (${e.message}); reusing the cached zip`);
      return zipPath;
    }
    throw e;
  }
}

// Load (or refresh) the feed. Downloads only when the cache is stale, and falls
// back to the cached zip when the network is down.
export async function loadModel({ dataDir = './data', log = () => {} } = {}) {
  const zipPath = await ensureZip(dataDir, log);
  const files = unzipSync(fs.readFileSync(zipPath));
  const model = buildModel(files, zipPath);
  log(`gtfs: ${model.routes.size} routes, ${[...model.services.values()].length} services, valid to ${model.validTo}`);
  return model;
}

// Plain JSON summaries for /api/routes and /api/health.
export function listRoutes(model) {
  return [...model.routes.values()]
    .map((r) => ({
      name: r.name,
      routeId: r.id,
      headsigns: r.headsigns,
      stopCount: r.stopCount,
      tripCount: r.tripCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function routeDetail(route) {
  return {
    name: route.name,
    routeId: route.id,
    directions: route.directions.map((d) => ({
      id: d.id,
      headsign: d.headsign,
      shape: d.shape,
      stops: d.stops.map((s) => ({ seq: s.seq, stopId: s.stopId, name: s.name, lat: s.lat, lng: s.lng })),
      trips: d.trips.map((t) => ({
        tripId: t.tripId,
        firstDeparture: t.firstDeparture,
        lastArrival: t.lastArrival,
        serviceId: t.serviceId,
        serviceLabel: t.serviceLabel,
      })),
    })),
  };
}
