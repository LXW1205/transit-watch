// ETA rules that are easy to get wrong and expensive to notice in production:
//   - a vehicle whose kiosk status is off_trip (layover / deadheading) must not
//     produce a single arrival estimate;
//   - a stale (live:false) vehicle must not either;
//   - an on_trip vehicle sitting on the route shape must produce ETAs.
//
// The vehicle is placed on a real stop of the route's shape, and "now" is derived
// from an actual trip's scheduled time at that stop, so the result does not depend
// on the wall clock or on which feed revision is cached.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { loadModel } from '../server/lib/gtfs.mjs';
import { estimateRoute } from '../server/lib/eta.mjs';
import { HAS_GTFS, SKIP_GTFS, freshDataDir, removeDir } from './helpers/gtfs-cache.mjs';

let dataDir = null;
let modelPromise = null;
const getModel = () => (modelPromise ??= loadModel({ dataDir, log: () => {} }));

if (HAS_GTFS) dataDir = freshDataDir();
after(() => removeDir(dataDir));

const etaCount = (result) =>
  result.directions.flatMap((d) => d.stops).filter((s) => s.etaMin !== null).length;

// Build a scenario anchored to the timetable: a stop on the canonical trip and a
// trip that serves it, with `now` set to that stop's scheduled arrival.
async function scenario() {
  const route = (await getModel()).byName.get('T504');
  const direction = route.directions[0];

  const stop = direction.stops[Math.min(10, direction.stops.length - 1)];
  const trip = direction.trips.find((t) => {
    const i = t.pattern.stopIds.indexOf(stop.stopId);
    return i >= 0 && Number.isFinite(t.arr[i]) && t.arr[i] < 86_400; // same KL day
  });
  assert.ok(trip, `no same-day trip serves ${stop.stopId}`);

  const arrivalS = trip.arr[trip.pattern.stopIds.indexOf(stop.stopId)];
  // Pick the KL date arbitrarily: without today/yesterday services, estimateRoute
  // measures every trip from offsets [0], so only the time of day matters.
  const now = Date.UTC(2026, 10, 9, 0, 0, 0) + (arrivalS - 8 * 3600) * 1000;

  const base = {
    lat: stop.lat,
    lng: stop.lng,
    route: 'T5040',
    direction: '02',
    ageS: 5,
    live: true,
    gpsTime: '2026-11-09 00:00:00', // unused by estimateRoute; ages are computed by the API
  };

  return { route, now, base };
}

test('estimateRoute: an off_trip vehicle produces zero stop ETAs', { skip: SKIP_GTFS }, async () => {
  const { route, now, base } = await scenario();

  const onTrip = { ...base, busNo: 'TEST-ON', status: 'on_trip' };
  const offTrip = { ...base, busNo: 'TEST-OFF', status: 'off_trip' };

  const on = estimateRoute(route, [onTrip], { now });
  const off = estimateRoute(route, [offTrip], { now });

  assert.ok(etaCount(on) > 0, 'an on_trip bus on the shape must produce ETAs');
  assert.equal(etaCount(off), 0, 'an off_trip bus must never invent ETAs');

  // The off_trip vehicle still appears in the estimates map (it stays on the map)
  // but is not assigned a direction, progress or next stop.
  assert.ok(off.estimates.has('TEST-OFF'));
  assert.deepEqual(off.estimates.get('TEST-OFF'), {
    directionId: null,
    progress: null,
    nextStop: null,
  });
  assert.equal(off.directions.flatMap((d) => d.stops).filter((s) => s.nextAt !== null).length, 0);

  const onEstimate = on.estimates.get('TEST-ON');
  assert.equal(onEstimate.directionId, 0);
  assert.ok(onEstimate.progress >= 0 && onEstimate.progress <= 1);
  assert.ok(onEstimate.nextStop, 'on_trip bus must have a next stop');
  assert.equal(typeof onEstimate.nextStop.seq, 'number');
  assert.equal(typeof onEstimate.nextStop.stopId, 'string');
  assert.ok(Number.isInteger(onEstimate.nextStop.etaMin) && onEstimate.nextStop.etaMin >= 0);
});

test('estimateRoute: a vehicle with live:false produces zero stop ETAs', { skip: SKIP_GTFS }, async () => {
  const { route, now, base } = await scenario();
  const stale = { ...base, busNo: 'TEST-STALE', status: 'on_trip', live: false };

  const result = estimateRoute(route, [stale], { now });
  assert.equal(etaCount(result), 0);
  assert.deepEqual(result.estimates.get('TEST-STALE').nextStop, null);
});

test('estimateRoute: every ETA is a whole minute >= 0 and nextAt agrees', { skip: SKIP_GTFS }, async () => {
  const { route, now, base } = await scenario();
  const vehicles = [
    { ...base, busNo: 'TEST-ON', status: 'on_trip' },
    { ...base, busNo: 'TEST-OFF', status: 'off_trip' },
  ];

  const result = estimateRoute(route, vehicles, { now });
  assert.equal(result.directions.length, route.directions.length);

  for (const d of result.directions) {
    assert.equal(d.stops.length, route.directions.find((x) => x.id === d.id).stops.length);
    for (const stop of d.stops) {
      if (stop.etaMin === null) {
        assert.equal(stop.nextAt, null, 'a null ETA must carry a null instant');
        continue;
      }
      assert.ok(Number.isInteger(stop.etaMin), `etaMin is not an int: ${stop.etaMin}`);
      assert.ok(stop.etaMin >= 0);
      assert.equal(stop.nextAt, new Date(now + stop.etaMin * 60_000).toISOString());
    }
  }
});

test('estimateRoute: nothing is invented for a vehicle off the shape', { skip: SKIP_GTFS }, async () => {
  const { route, now, base } = await scenario();
  // >250 m from any segment of the route: treated as not on this route.
  const away = { ...base, lat: base.lat + 0.05, lng: base.lng + 0.05, busNo: 'TEST-AWAY', status: 'on_trip' };

  const result = estimateRoute(route, [away], { now });
  assert.equal(etaCount(result), 0);
  assert.deepEqual(result.estimates.get('TEST-AWAY'), {
    directionId: null,
    progress: null,
    nextStop: null,
  });
});
