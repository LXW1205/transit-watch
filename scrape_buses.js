#!/usr/bin/env node
// Scrape live bus positions for MyRapid feeder routes from Prasarana's AVL socket.
//
//   node scrape_buses.js                              # default: T504,T505
//   node scrape_buses.js T504 T505                    # by route name
//   node scrape_buses.js 1043 1044                    # by the kiosk's route id
//   node scrape_buses.js --no-history
//   node scrape_buses.js --timeout 45000
//
// Contract: the ONLY thing on stdout is one JSON document. Diagnostics go to
// stderr. Exit codes: 0 = ok, 1 = scrape failed, 2 = bad usage.
//
// How the data source works (see README.md for the full write-up):
//   1. wss://rapidbus-socketio-avl.prasarana.com.my/socket.io/?EIO=4&transport=websocket
//   2. open the namespace: send "40", wait for '40{"sid":...}'
//   3. emit 'onFts-reload' WITH an ack id: '421["onFts-reload",{...}]'
//      - without the ack id the handler's callback is never invoked → no data, ever
//      - the payload must be an inline object, not a stringified string
//   4. server replies 'onFts-client' with base64(gzip(json))
//   5. answer Engine.IO pings: on '2', reply '3'

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flags = { history: true, state: path.join(SCRIPT_DIR, 'state', 'buses.json'), timeout: 30000 };
const routesIn = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-history') flags.history = false;
  else if (a === '--state') flags.state = argv[++i];
  else if (a === '--timeout') flags.timeout = Number(argv[++i]);
  else if (a.startsWith('--')) fail_usage(`unknown flag: ${a}`);
  else routesIn.push(...a.split(',').map(s => s.trim()).filter(Boolean));
}
function fail_usage(msg) {
  process.stderr.write(`${msg}\nusage: node scrape_buses.js [route ...] [--no-history] [--timeout ms]\n`);
  process.exit(2);
}

const PROVIDER = 'RKL';
const AVL_URL = 'https://rapidbus-socketio-avl.prasarana.com.my/socket.io/?EIO=4&transport=websocket';
// session id scraped from https://myrapidbus.prasarana.com.my/kiosk?route=1043
// (not validated server-side; the HTML host sits behind Incapsula but this
// websocket host does not, which is why the socket path works from a script)
const PAGE_SID = 'tv87hhbjs4ppcknvr5b41m1nmqcg0gea';
const DEFAULT_ROUTES = ['T504', 'T505'];

// trip_rev_kind legend, taken from the kiosk page's icon mapping
const STATUS = { '00': 'on_trip', '99': 'off_trip', '01': 'contingency', '03': 'contingency', '05': 'contingency' };

// ---------------------------------------------------------------- route aliases
function loadAliases() {
  try { return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'route_ids.json'), 'utf8')); }
  catch { return {}; }
}
const ALIASES = loadAliases();

function resolveRoute(token) {
  if (/^\d+$/.test(token)) {
    const name = ALIASES[token];
    if (!name) return { error: `unknown route id ${token} (not in route_ids.json)` };
    return { name, requested: token };
  }
  return { name: token.replace(/\s*\(OS\)$/, ''), requested: token };
}

const resolved = (routesIn.length ? routesIn : DEFAULT_ROUTES).map(resolveRoute);
const bad = resolved.filter(r => r.error);
if (bad.length) { bad.forEach(b => process.stderr.write(`[buses] ${b.error}\n`)); process.exit(2); }
const routes = [...new Set(resolved.map(r => r.name))];
const requestedFor = Object.fromEntries(resolved.map(r => [r.name, r.requested]));

// ---------------------------------------------------------------- state
function loadHistory() {
  if (!flags.history) return { data: { runs: {} } };
  try {
    const d = JSON.parse(fs.readFileSync(flags.state, 'utf8'));
    if (d && typeof d === 'object' && d.runs) return { data: d };
  } catch { /* first run */ }
  return { data: { runs: {} } };
}
function saveHistory(h) {
  if (!flags.history) return;
  fs.mkdirSync(path.dirname(flags.state), { recursive: true });
  fs.writeFileSync(flags.state, JSON.stringify(h.data, null, 2) + '\n');
}

// ---------------------------------------------------------------- emit
function emit(doc, code) { process.stdout.write(JSON.stringify(doc, null, 2) + '\n'); process.exit(code); }

// ---------------------------------------------------------------- scrape
const history = loadHistory();
const now = Date.now();
const out = Object.fromEntries(routes.map(r => [r, { requested: requestedFor[r], buses: [] }]));
let socketError = null;

// "T504" should match route "T504" or the variant "T5040" (name + direction digit),
// but must NOT let "T50" swallow "T504".
const routeMatches = (actual, name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d?$`).test(String(actual || ''));

await new Promise(resolve => {
  let ws, ackId = 0, settled = false;
  const finish = (err) => {
    if (settled) return;
    settled = true;
    socketError = err;
    try { ws?.close(); } catch { /* ignore */ }
    resolve();
  };
  let receivedPayloads = 0;
  let idleTimer = null;
  let timer = setTimeout(() => finish(
    receivedPayloads === 0
      ? { reason: 'no_payload', detail: `no data from the AVL socket within ${flags.timeout}ms` }
      : null
  ), flags.timeout);

  try { ws = new WebSocket(AVL_URL); }
  catch (e) { clearTimeout(timer); finish({ reason: 'connect', detail: e.message }); }

  ws.addEventListener('error', e => { clearTimeout(timer); finish({ reason: 'connect', detail: String(e.message || e) }); });
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : '';
    if (raw[0] === '0') { ws.send('40'); return; }          // engine.io OPEN → socket.io CONNECT
    if (raw[0] === '2') { ws.send('3'); return; }           // engine.io PING → PONG
    if (raw.startsWith('40')) {                             // namespace open → subscribe
      setTimeout(() => routes.forEach(route => {
        const payload = { sid: PAGE_SID, uid: '', provider: PROVIDER, route };
        ws.send(`42${++ackId}["onFts-reload",${JSON.stringify(payload)}]`);
        process.stderr.write(`[buses] subscribed to ${route} (${requestedFor[route]})\n`);
      }), 300);
      return;
    }
    if (raw[0] === '4' && raw[1] === '3') return;           // socket.io ACK
    if (raw[0] !== '4' || raw[1] !== '2') return;

    let args;
    try { args = JSON.parse(raw.slice(2)); } catch { return; }
    if (args[0] !== 'onFts-client') return;

    let data;
    try { data = JSON.parse(zlib.gunzipSync(Buffer.from(args[1], 'base64')).toString('utf8')); }
    catch (e) { clearTimeout(timer); finish({ reason: 'decode', detail: `gunzip/parse failed: ${e.message}` }); return; }
    receivedPayloads++;

    for (const b of Object.values(data)) {
      if (!b || !b.bus_no) continue;
      const target = routes.find(r => routeMatches(b.route, r));
      if (!target) continue;
      const gpsMs = Date.parse(String(b.dt_gps).replace(' ', 'T') + '+08:00');
      const ageS = Number.isNaN(gpsMs) ? null : Math.max(0, Math.round((now - gpsMs) / 1000));
      const rec = {
        bus_no: b.bus_no, route: b.route, direction: b.dir,
        lat: b.latitude, lng: b.longitude, speed_kmh: Number(b.speed) || 0,
        status: STATUS[b.trip_rev_kind] || `unknown(${b.trip_rev_kind})`,
        gps_time: b.dt_gps, gps_age_s: ageS,
        live: ageS !== null && ageS <= 300,   // the kiosk page itself treats >5min as stale
      };
      const bucket = out[target].buses;
      const i = bucket.findIndex(x => x.bus_no === rec.bus_no);
      if (i >= 0) bucket[i] = rec; else bucket.push(rec);
    }

    // The server sends one payload per onFts-reload, but we can't attribute a
    // payload to a route until we match buses from it — so a route with no buses
    // running would otherwise never look "done". Finish once every requested
    // route has at least one bus, otherwise fall back to an idle window. A run
    // that received payloads is a *success* even if it ends with 0 buses: at
    // night that is the true answer, not a timeout.
    clearTimeout(idleTimer);
    if (routes.every(r => out[r].buses.length > 0)) {
      idleTimer = setTimeout(() => finish(null), 400);
    } else {
      idleTimer = setTimeout(() => finish(null), receivedPayloads >= routes.length ? 1500 : 5000);
    }
  });
});

if (socketError) {
  emit({ fetched_at: new Date().toISOString(), ok: false, error: socketError, provider: PROVIDER, routes: out }, 1);
}

// ---------------------------------------------------------------- summarise
const parts = [];
for (const r of routes) {
  const bucket = out[r];
  const live = bucket.buses.filter(b => b.live).length;
  const byStatus = {};
  for (const b of bucket.buses) byStatus[b.status] = (byStatus[b.status] || 0) + 1;

  const prev = history.data.runs[r] || null;
  bucket.total = bucket.buses.length;
  bucket.live = live;
  bucket.stale = bucket.buses.length - live;
  bucket.by_status = byStatus;
  bucket.change = prev
    ? { previous_live: prev.live, delta_live: live - prev.live,
        previous_total: prev.total, delta_total: bucket.total - prev.total,
        previous_fetched_at: prev.fetched_at }
    : null;
  history.data.runs[r] = { live, total: bucket.total, fetched_at: new Date().toISOString() };

  const statusBits = Object.entries(byStatus).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ');
  parts.push(`${r}: ${bucket.total} bus${bucket.total === 1 ? '' : 'es'} on route ` +
    `(${bucket.live} live, ${bucket.stale} stale${statusBits ? '; ' + statusBits : ''})`);
}
if (flags.history) {
  fs.mkdirSync(path.dirname(flags.state), { recursive: true });
  fs.writeFileSync(flags.state, JSON.stringify(history.data, null, 2) + '\n');
}
for (const p of parts) process.stderr.write(`[buses] ${p}\n`);

emit({
  fetched_at: new Date().toISOString(),
  ok: true,
  provider: PROVIDER,
  routes_checked: routes,
  totals: {
    buses: routes.reduce((n, r) => n + out[r].total, 0),
    live: routes.reduce((n, r) => n + out[r].live, 0),
    stale: routes.reduce((n, r) => n + out[r].stale, 0),
  },
  any_change: routes.some(r => out[r].change && (out[r].change.delta_live || out[r].change.delta_total)),
  summary: parts.join('. ') + '.',
  routes: out,
}, 0);
