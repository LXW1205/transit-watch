// GTFS: the pure CSV/time/geometry helpers always run; the feed-dependent
// assertions skip when the gitignored zip cache is absent (clean checkout).

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadModel,
  csvRows,
  clockToSeconds,
  secondsToClock,
  addDays,
  snapToShape,
  distAtProjection,
  needsRefresh,
  servicesOn,
  listRoutes,
  routeDetail,
} from '../server/lib/gtfs.mjs';
import { HAS_GTFS, SKIP_GTFS, freshDataDir, removeDir } from './helpers/gtfs-cache.mjs';

// ---------------------------------------------------------------- pure helpers
test('csvRows: skips the header, handles CRLF and quoted commas/quotes', () => {
  const text = 'a,b,c\n1,2,3\r\n"x,y",2,"he said ""hi"""\n';
  assert.deepEqual([...csvRows(text)], [
    ['1', '2', '3'],
    ['x,y', '2', 'he said "hi"'],
  ]);
});

test('clockToSeconds: parses GTFS clocks, including after-midnight times', () => {
  assert.equal(clockToSeconds('06:00:00'), 21_600);
  assert.equal(clockToSeconds('00:00:00'), 0);
  assert.equal(clockToSeconds('25:30:00'), 91_800); // beyond 24:00 is legal
  assert.equal(clockToSeconds(' 07:05:09 '), 25_509);
  assert.ok(Number.isNaN(clockToSeconds('6:00')));
  assert.ok(Number.isNaN(clockToSeconds('')));
  assert.ok(Number.isNaN(clockToSeconds(undefined)));
});

test('secondsToClock: zero-pads and round-trips clockToSeconds', () => {
  assert.equal(secondsToClock(0), '00:00:00');
  assert.equal(secondsToClock(21_609), '06:00:09');
  assert.equal(secondsToClock(91_800), '25:30:00'); // after-midnight trips stay > 24 h
  assert.equal(secondsToClock(-5), '00:00:00', 'negative seconds clamp to zero');
  for (const clock of ['00:00:00', '06:45:00', '23:59:59', '25:30:00']) {
    assert.equal(secondsToClock(clockToSeconds(clock)), clock);
  }
});

test('addDays: crosses month, year and leap boundaries in UTC', () => {
  assert.equal(addDays('2026-11-09', 1), '2026-11-10');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('needsRefresh: null, stale, and near-expiry models refresh', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  assert.equal(needsRefresh(null, now), true);
  assert.equal(
    needsRefresh({ fetchedAt: new Date(now - 1000).toISOString(), validTo: '2999-12-31' }, now),
    false,
  );
  assert.equal(
    needsRefresh({ fetchedAt: new Date(now - 25 * 3600_000).toISOString(), validTo: '2999-12-31' }, now),
    true,
    'a day-old feed is refreshed',
  );
  assert.equal(
    needsRefresh({ fetchedAt: new Date(now).toISOString(), validTo: '' }, now),
    true,
    'an unknown validity window needs a refresh',
  );
});

test('snapToShape: projects onto the nearest segment and measures in metres', () => {
  const shape = [[0, 0], [0, 0.01]]; // ~1.1 km straight north at the equator
  const hits = snapToShape(shape, 0, 0.005);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].index, 0);
  assert.ok(Math.abs(hits[0].t - 0.5) < 1e-9, `t should be 0.5, got ${hits[0].t}`);
  assert.ok(hits[0].distM < 1e-6, `point is on the shape, got ${hits[0].distM} m`);

  const off = snapToShape(shape, 0.01, 0.005);
  assert.equal(off.length, 1, 'without tolerance only the nearest segment is returned');
  assert.ok(Math.abs(off[0].distM - 1105.4) < 5, `expected ~1105 m, got ${off[0].distM}`);
});

test('distAtProjection: interpolates and tolerates the last vertex', () => {
  const pointDist = [0, 1.5, 3];
  assert.equal(distAtProjection(pointDist, 0, 0), 0);
  assert.equal(distAtProjection(pointDist, 0, 0.5), 0.75);
  assert.equal(distAtProjection(pointDist, 1, 1), 3);
  assert.equal(distAtProjection(pointDist, 2, 0.5), 3, 'index past the end clamps to the last value');
});

// ---------------------------------------------------------------- feed model
let dataDir = null;
let modelPromise = null;
const getModel = () => (modelPromise ??= loadModel({ dataDir, log: () => {} }));

// Only create/copy the feed when it exists; skipped tests must not touch the disk.
if (HAS_GTFS) dataDir = freshDataDir();
after(() => removeDir(dataDir));

test('loadModel: parses the feed into 91 routes with a validity window', { skip: SKIP_GTFS }, async () => {
  const model = await getModel();
  assert.equal(model.routes.size, 91);
  assert.equal(model.byName.size, 91);
  assert.match(model.validTo, /^\d{4}-\d{2}-\d{2}$/, 'validTo must be an ISO date');
  assert.ok(model.fetchedAt, 'fetchedAt is stamped');
});

test('loadModel: route names come from route_long_name (T504/T505 → ids)', { skip: SKIP_GTFS }, async () => {
  const model = await getModel();

  const r504 = model.byName.get('T504');
  const r505 = model.byName.get('T505');
  assert.ok(r504, 'T504 must resolve by its long name');
  assert.ok(r505, 'T505 must resolve by its long name');
  assert.equal(r504.id, '30000150');
  assert.equal(r505.id, '30000151');
  assert.equal(r504.name, 'T504');
  assert.equal(r505.name, 'T505');

  // route_short_name is empty, so public stop ids are stop_code values (SP398,
  // SP380B), never the numeric stop_id.
  for (const route of [r504, r505]) {
    for (const d of route.directions) {
      for (const stop of d.stops) {
        assert.match(stop.stopId, /^SP\w+$/, `stopId ${stop.stopId} is not a stop_code`);
        assert.doesNotMatch(stop.stopId, /^\d+$/, `stopId ${stop.stopId} looks like a numeric stop_id`);
      }
    }
  }
  assert.equal(r504.directions[0].stops[0].stopId, 'SP398');
});

test('loadModel: T504 is a one-direction loop with 31 ordered stops and 80 trips', { skip: SKIP_GTFS }, async () => {
  const route = (await getModel()).byName.get('T504');
  assert.equal(route.directions.length, 1, 'served as a single loop direction');
  assert.equal(route.stopCount, 31);
  assert.equal(route.tripCount, 80);

  const [direction] = route.directions;
  assert.equal(direction.id, 0);
  assert.ok(direction.headsign.length > 0);
  assert.ok(direction.shape.length > 100, `shape should be a real polyline, got ${direction.shape.length}`);
  assert.equal(direction.pointDist.length, direction.shape.length, 'distances parallel the shape');

  assert.equal(direction.stops.length, 31, 'canonical trip serves 31 stops');
  for (let i = 1; i < direction.stops.length; i++) {
    assert.ok(
      direction.stops[i].seq > direction.stops[i - 1].seq,
      `stops must be ordered by seq, ${direction.stops[i - 1].seq} then ${direction.stops[i].seq}`,
    );
  }
  for (const stop of direction.stops) {
    assert.ok(stop.name.length > 0);
    assert.ok(Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
  }

  assert.equal(direction.trips.length, 80);
  for (let i = 1; i < direction.trips.length; i++) {
    assert.ok(
      direction.trips[i].firstDeparture >= direction.trips[i - 1].firstDeparture,
      'trips must be sorted by firstDeparture',
    );
  }
  for (const trip of direction.trips) {
    assert.match(trip.tripId, /\S/);
    assert.match(trip.firstDeparture, /^\d{2}:\d{2}:\d{2}$/);
    assert.match(trip.lastArrival, /^\d{2}:\d{2}:\d{2}$/);
    assert.ok(['weekday', 'weekend', 'daily', 'other'].includes(trip.serviceLabel));
    assert.ok(trip.arr instanceof Int32Array && trip.dep instanceof Int32Array);
  }
});

test('listRoutes: 91 rows sorted by name with name/routeId', { skip: SKIP_GTFS }, async () => {
  const routes = listRoutes(await getModel());
  assert.equal(routes.length, 91);
  const names = routes.map((r) => r.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  for (const r of routes) {
    assert.equal(typeof r.name, 'string');
    assert.match(r.routeId, /^\d+$/);
    assert.ok(Array.isArray(r.headsigns));
    assert.ok(Number.isInteger(r.stopCount) && r.stopCount > 0);
    assert.ok(Number.isInteger(r.tripCount) && r.tripCount > 0);
  }
});

test('routeDetail: serves [lat,lng] shape points and contract trip fields', { skip: SKIP_GTFS }, async () => {
  const model = await getModel();
  const detail = routeDetail(model.byName.get('T504'));

  assert.deepEqual(Object.keys(detail), ['name', 'routeId', 'directions']);
  assert.equal(detail.routeId, '30000150');
  const [d] = detail.directions;
  assert.ok(Array.isArray(d.shape));
  assert.ok(d.shape.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)));
  assert.deepEqual(Object.keys(d.stops[0]), ['seq', 'stopId', 'name', 'lat', 'lng']);
  assert.deepEqual(
    Object.keys(d.trips[0]),
    ['tripId', 'firstDeparture', 'lastArrival', 'serviceId', 'serviceLabel'],
  );
});

test('servicesOn: resolves a service date from the feed calendar and caches it', { skip: SKIP_GTFS }, async () => {
  const model = await getModel();

  // Derive the probe date from the feed itself: the calendar rolls monthly, so a
  // hard-coded date would rot. Pick the first date inside a service's window on
  // which its own weekday flags say it runs, and which calendar_dates does not
  // override.
  const probe = (service) => {
    for (let i = 0; i < 35; i++) {
      const date = addDays(service.start, i);
      if (date > service.end) break;
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
      if (service.days[(dow + 6) % 7] && !service.exceptions.has(date)) return date;
    }
    return null;
  };

  assert.ok(model.services.size >= 1);
  for (const service of model.services.values()) {
    const date = probe(service);
    if (!date) continue;
    const active = servicesOn(model, date);
    assert.ok(active instanceof Set);
    assert.ok(active.has(service.id), `${service.id} must run on ${date}`);
    assert.equal(servicesOn(model, date), active, 'repeat calls return the cached set');
    for (const id of active) assert.ok(model.services.has(id), `unknown service ${id}`);

    // A day one week later follows the same weekday flags, unless an exception
    // intervenes; at minimum it must be a Set.
    const later = servicesOn(model, addDays(date, 7));
    assert.ok(later instanceof Set);
  }
});
