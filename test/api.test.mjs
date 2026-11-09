// Black-box API smoke test: spawn the real server on an ephemeral port against a
// temp copy of the cached GTFS feed, then assert the docs/API.md contract.
//
// Offline by construction:
//   - DATA_DIR is a temp dir holding the cached zip with a fresh mtime, so
//     loadModel() never re-downloads;
//   - the AVL websocket is replaced by a preloaded stub (--import), so /live never
//     opens a real socket but still exercises the real ETA path;
//   - /api/flights is only called with a past date, which fails validation before
//     any fetch.
//
// The child is always killed by PID — never a broad pkill.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, SKIP_GTFS, freshDataDir, removeDir } from './helpers/gtfs-cache.mjs';

const STUB_URL = pathToFileURL(path.join(REPO_ROOT, 'test', 'helpers', 'stub-websocket.mjs')).href;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let child = null;
let dataDir = null;
let base = '';
let stderr = '';

before(async () => {
  if (SKIP_GTFS) return;
  dataDir = freshDataDir();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  child = spawn(
    process.execPath,
    ['--import', STUB_URL, 'server/index.mjs'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}):\n${stderr}`);
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      const body = await res.json();
      if (body.gtfs?.loaded) return;
    } catch { /* not listening yet */ }
    await delay(100);
  }
  throw new Error(`server did not load GTFS in 25s:\n${stderr}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      once(child, 'exit').then(() => true),
      delay(2000).then(() => false),
    ]);
    if (!exited) child.kill('SIGKILL');
  }
  removeDir(dataDir);
});

const get = async (p) => {
  const res = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json() };
};

test('GET /api/health → 200 with loaded GTFS', { skip: SKIP_GTFS }, async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(typeof body.ok, 'boolean');
  assert.equal(body.ok, true, `GTFS failed to load:\n${stderr}`);
  assert.equal(typeof body.gtfs.routes, 'number');
  assert.equal(body.gtfs.routes, 91);
  assert.equal(body.gtfs.loaded, true);
});

test('GET /api/routes → default T504/T505 and name/routeId on every route', { skip: SKIP_GTFS }, async () => {
  const { status, body } = await get('/api/routes');
  assert.equal(status, 200);
  assert.deepEqual(body.default, ['T504', 'T505']);
  assert.equal(body.routes.length, 91);
  for (const route of body.routes) {
    assert.equal(typeof route.name, 'string');
    assert.equal(typeof route.routeId, 'string');
    assert.ok(route.name.length > 0);
    assert.match(route.routeId, /^\d+$/);
  }
  const names = body.routes.map((r) => r.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'sorted by name');
});

test('GET /api/route/T504 → one loop direction, long shape, 31 ordered stops, 80 trips', { skip: SKIP_GTFS }, async () => {
  const { status, body } = await get('/api/route/T504');
  assert.equal(status, 200);
  assert.equal(body.name, 'T504');
  assert.equal(body.routeId, '30000150');

  assert.equal(body.directions.length, 1, 'T504 is a single-direction loop');
  const [dir] = body.directions;
  assert.equal(dir.id, 0);
  assert.ok(Array.isArray(dir.shape));
  assert.ok(dir.shape.length > 100, `shape should be a real polyline, got ${dir.shape.length}`);

  assert.equal(dir.stops.length, 31);
  for (let i = 1; i < dir.stops.length; i++) {
    assert.ok(dir.stops[i].seq > dir.stops[i - 1].seq, `stop ${i} is out of seq order`);
  }
  assert.match(dir.stops[0].stopId, /^SP\d+$/, 'stop ids are stop_code values');
  assert.equal(dir.stops[0].stopId, 'SP398');

  assert.equal(dir.trips.length, 80);
  for (let i = 1; i < dir.trips.length; i++) {
    assert.ok(dir.trips[i].firstDeparture >= dir.trips[i - 1].firstDeparture, 'trips sorted by departure');
  }
});

test('GET /api/route/T504/live → 200, boolean live flags, sane ETA minutes', { skip: SKIP_GTFS }, async () => {
  const { status, body } = await get('/api/route/T504/live');
  assert.equal(status, 200);
  assert.equal(body.route, 'T504');
  assert.equal(typeof body.stale, 'boolean');
  assert.ok(Array.isArray(body.vehicles));
  assert.ok(body.vehicles.length > 0, `stub socket should deliver a bus, stderr:\n${stderr}`);
  assert.equal(body.stale, false, 'freshly collected data is not stale');

  for (const v of body.vehicles) {
    assert.equal(typeof v.live, 'boolean');
    assert.equal(v.live, true, 'stub bus has a fresh GPS fix');
    assert.equal(v.status, 'on_trip');
    assert.equal(typeof v.busNo, 'string');
  }

  assert.ok(Array.isArray(body.directions) && body.directions.length === 1);
  let withEta = 0;
  for (const dir of body.directions) {
    for (const stop of dir.stops) {
      if (stop.etaMin === null) {
        assert.equal(stop.nextAt, null, 'null ETA must carry a null instant');
        continue;
      }
      withEta++;
      assert.ok(Number.isInteger(stop.etaMin), `etaMin must be an integer, got ${stop.etaMin}`);
      assert.ok(stop.etaMin >= 0, `etaMin must be >= 0, got ${stop.etaMin}`);
      assert.equal(typeof stop.nextAt, 'string');
    }
  }
  // ETAs are clock-dependent (null late at night), but never fabricated.
  assert.ok(withEta <= body.directions[0].stops.length);
});

test('GET /api/route/NOPE → 404 with the error envelope', { skip: SKIP_GTFS }, async () => {
  const { status, body } = await get('/api/route/NOPE');
  assert.equal(status, 404);
  assert.equal(typeof body.error.reason, 'string');
  assert.equal(typeof body.error.detail, 'string');
  assert.equal(body.error.reason, 'not_found');
});

test('GET /api/flights with a past out date → 400 past_date, no network', { skip: SKIP_GTFS }, async () => {
  const { status, body } = await get('/api/flights?from=KBR&to=KUL&out=2020-01-01');
  assert.equal(status, 400);
  assert.equal(body.error.reason, 'past_date');
  assert.equal(typeof body.error.detail, 'string');
});

test('GET /api/flights with a bad IATA code → 400 bad_request', { skip: SKIP_GTFS }, async () => {
  const { status, body } = await get('/api/flights?from=XX&to=KUL&out=2099-01-01');
  assert.equal(status, 400);
  assert.equal(body.error.reason, 'bad_request');
});
