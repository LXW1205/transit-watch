// Transit dashboard API — implements docs/API.md (frozen contract, v1).
//
//   PORT      listening port                      (default 8787)
//   ROUTES    comma separated routes to preselect (default T504,T505)
//   DATA_DIR  cache directory for the GTFS zip    (default ./data)
//
// In production (NODE_ENV=production) dist/ is served statically when it exists,
// so one process can host the built UI and the API.
//
// The server starts and answers /api/health with no network: GTFS loads in the
// background, the live socket is only opened when a live request arrives.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { loadModel, needsRefresh, listRoutes, routeDetail, servicesOn, addDays } from './lib/gtfs.mjs';
import { collectPositions, LIVE_AGE_S } from './lib/live.mjs';
import { estimateRoute, klClock } from './lib/eta.mjs';
import { getFares, ScrapeError } from './lib/flights.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT) || 8787;
const DEFAULT_ROUTES = (process.env.ROUTES || 'T504,T505')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DIST_DIR = path.join(ROOT, 'dist');

// GTFS refresh: checked hourly, re-downloaded when the cache or calendar is stale
const GTFS_CHECK_MS = 60 * 60 * 1000;
// repeated live requests inside this window share one collection
const LIVE_SHARE_MS = 5 * 1000;
const LIVE_TIMEOUT_MS = 20 * 1000;
// the contract's staleness rule for live data
const LIVE_STALE_MS = 5 * 60 * 1000;

const log = (msg) => process.stderr.write(`[api] ${msg}\n`);

// ---------------------------------------------------------------- gtfs state
const gtfs = { model: null, error: null, loading: null };

function refreshGtfs(force = false) {
  if (gtfs.loading) return gtfs.loading;
  if (!force && gtfs.model && !needsRefresh(gtfs.model)) return Promise.resolve(gtfs.model);

  gtfs.loading = (async () => {
    try {
      gtfs.model = await loadModel({ dataDir: DATA_DIR, log });
      gtfs.error = null;
    } catch (e) {
      // keep the previous model — a stale feed beats no feed
      gtfs.error = e;
      log(`gtfs: load failed — ${e.message}`);
    } finally {
      gtfs.loading = null;
    }
    return gtfs.model;
  })();
  return gtfs.loading;
}

// ---------------------------------------------------------------- live state
// One collector cache per route set: the UI polls T504 and T505 every 15 s, which
// must not open two sockets.
const liveCache = new Map();

function liveEntry(name) {
  const names = DEFAULT_ROUTES.includes(name) ? DEFAULT_ROUTES : [name];
  const key = names.join(',');
  let entry = liveCache.get(key);
  if (!entry) liveCache.set(key, entry = { names, last: null, at: 0, collectedAt: 0, inflight: null });
  return entry;
}

async function collectLive(name) {
  const entry = liveEntry(name);
  const now = Date.now();
  // shared window: a fresh-enough answer, or the one already in flight
  if (entry.at && now - entry.at < LIVE_SHARE_MS) return entry;
  if (entry.inflight) return entry.inflight;

  entry.inflight = collectPositions(entry.names, { timeoutMs: LIVE_TIMEOUT_MS, log })
    .then((res) => {
      entry.at = Date.now();
      // an empty result is still an answer; only a transport failure keeps the
      // previous buses so the map does not blink
      if (res.ok) {
        entry.last = res;
        entry.collectedAt = Date.parse(res.fetchedAt);
      } else {
        log(`live: collect failed — ${res.error.reason}: ${res.error.detail}`);
      }
      return entry;
    })
    .finally(() => { entry.inflight = null; });

  return entry.inflight;
}

// ---------------------------------------------------------------- helpers
const fail = (res, status, reason, detail) =>
  res.status(status).json({ error: { reason, detail } });

function requireGtfs(res) {
  if (gtfs.model) return true;
  fail(res, 503, 'gtfs_unavailable',
    gtfs.error ? `GTFS feed unavailable: ${gtfs.error.message}` : 'GTFS feed is still loading');
  return false;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---------------------------------------------------------------- app
const app = express();
app.set('etag', false);   // every response is time dependent

app.get('/api/health', (req, res) => {
  const model = gtfs.model;
  const entry = liveCache.get(DEFAULT_ROUTES.join(','));
  res.json({
    ok: Boolean(model),
    uptimeS: Math.round(process.uptime()),
    gtfs: {
      loaded: Boolean(model),
      fetchedAt: model?.fetchedAt ?? null,
      routes: model?.routes.size ?? 0,
      serviceValidTo: model?.validTo ?? null,
    },
    live: {
      lastAt: entry?.last?.fetchedAt ?? null,
      vehicles: entry?.last ? entry.names.reduce((n, r) => n + (entry.last.routes[r]?.buses.length || 0), 0) : 0,
    },
  });
});

app.get('/api/routes', (req, res) => {
  if (!requireGtfs(res)) return;
  res.json({ routes: listRoutes(gtfs.model), default: DEFAULT_ROUTES });
});

app.get('/api/route/:name', (req, res) => {
  if (!requireGtfs(res)) return;
  const route = gtfs.model.byName.get(req.params.name);
  if (!route) return fail(res, 404, 'not_found', `unknown route: ${req.params.name}`);
  res.json(routeDetail(route));
});

app.get('/api/route/:name/live', async (req, res) => {
  if (!requireGtfs(res)) return;
  const route = gtfs.model.byName.get(req.params.name);
  if (!route) return fail(res, 404, 'not_found', `unknown route: ${req.params.name}`);

  const entry = await collectLive(route.name);
  const collected = entry.last;
  const buses = collected?.routes?.[route.name]?.buses ?? [];
  const stale = !entry.collectedAt || Date.now() - entry.collectedAt > LIVE_STALE_MS;

  // Ages are recomputed here: shared/cached collections must not freeze them.
  const nowMs = Date.now();
  const vehicles = buses.map((b) => {
    const gpsMs = Date.parse(String(b.gps_time).replace(' ', 'T') + '+08:00');
    const ageS = Number.isNaN(gpsMs) ? null : Math.max(0, Math.round((nowMs - gpsMs) / 1000));
    return {
      busNo: b.bus_no,
      route: b.route,
      direction: b.direction,
      lat: b.lat,
      lng: b.lng,
      speedKmh: b.speed_kmh,
      gpsTime: b.gps_time,
      ageS,
      live: ageS !== null && ageS <= LIVE_AGE_S,
      status: b.status,
      directionId: null,
      progress: null,
      bearing: null,
      nextStop: null,
    };
  });

  const clock = klClock(nowMs);
  const { directions, estimates } = estimateRoute(route, vehicles, {
    now: nowMs,
    todayServices: servicesOn(gtfs.model, clock.date),
    yesterdayServices: servicesOn(gtfs.model, addDays(clock.date, -1)),
  });

  for (const v of vehicles) {
    const est = estimates.get(v.busNo);
    if (!est) continue;
    v.directionId = est.directionId;
    v.progress = est.progress;
    v.bearing = est.bearing;
    v.nextStop = est.nextStop;
  }

  res.json({
    route: route.name,
    updatedAt: collected?.fetchedAt ?? null,
    stale,
    vehicles,
    directions,
  });
});

app.get('/api/flights', async (req, res) => {
  const from = String(req.query.from || '').toUpperCase();
  const to = String(req.query.to || '').toUpperCase();
  const out = String(req.query.out || '');
  const ret = req.query.ret ? String(req.query.ret) : null;
  const sweep = req.query.sweep === undefined ? 0 : Number(req.query.sweep);

  if (!/^[A-Z]{3}$/.test(from)) return fail(res, 400, 'bad_request', 'from must be a 3-letter IATA code');
  if (!/^[A-Z]{3}$/.test(to)) return fail(res, 400, 'bad_request', 'to must be a 3-letter IATA code');
  if (!isDate(out)) return fail(res, 400, 'bad_request', 'out must be YYYY-MM-DD');
  if (ret !== null && !isDate(ret)) return fail(res, 400, 'bad_request', 'ret must be YYYY-MM-DD');
  if (!Number.isInteger(sweep) || sweep < 0 || sweep > 7) {
    return fail(res, 400, 'bad_request', 'sweep must be an integer 0..7');
  }

  try {
    res.json(await getFares({ from, to, out, ret, sweep }));
  } catch (e) {
    if (e instanceof ScrapeError && (e.reason === 'past_date' || e.reason === 'bad_request')) {
      return fail(res, 400, e.reason, e.detail);
    }
    log(`flights: ${from}-${to} ${out} failed — ${e.reason || e.message}`);
    // a scrape failure is an upstream problem, not ours
    return fail(res, 502, e.reason || 'scrape_failed', e.detail || e.message || String(e));
  }
});

// dist/ in production, with an SPA fallback for anything outside /api
if (process.env.NODE_ENV === 'production' && fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  log(`server: serving ${DIST_DIR}`);
}

app.use('/api', (req, res) => fail(res, 404, 'not_found', `no such endpoint: ${req.method} ${req.originalUrl}`));

// eslint-disable-next-line no-unused-vars — express identifies the error handler by arity
app.use((err, req, res, next) => {
  log(`error: ${err?.stack || err}`);
  if (res.headersSent) return next(err);
  fail(res, 500, 'internal', err?.message || String(err));
});

// ---------------------------------------------------------------- start
const server = app.listen(PORT, () => {
  log(`server: listening on :${PORT} (routes ${DEFAULT_ROUTES.join(',')}, data ${DATA_DIR})`);
});

// load the feed in the background so /api/health answers immediately
refreshGtfs().then((model) => {
  if (model) log(`server: GTFS ready with ${model.routes.size} routes`);
});
setInterval(() => { refreshGtfs().catch((e) => log(`gtfs: refresh error — ${e.message}`)); }, GTFS_CHECK_MS).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`server: ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
