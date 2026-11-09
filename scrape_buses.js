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
// The collector itself lives in server/lib/live.mjs so the API shares it; this file
// is the CLI around it: argument parsing, route-id aliases, history and summary.
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
import { fileURLToPath } from 'node:url';
import { collectPositions, PROVIDER } from './server/lib/live.mjs';

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

const DEFAULT_ROUTES = ['T504', 'T505'];

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

// ---------------------------------------------------------------- emit
function emit(doc, code) { process.stdout.write(JSON.stringify(doc, null, 2) + '\n'); process.exit(code); }

// ---------------------------------------------------------------- scrape
const history = loadHistory();
const out = Object.fromEntries(routes.map(r => [r, { requested: requestedFor[r], buses: [] }]));

const collected = await collectPositions(routes, {
  timeoutMs: flags.timeout,
  log: (msg) => process.stderr.write(`[buses] ${msg}\n`),
});
for (const r of routes) out[r].buses = collected.routes[r]?.buses ?? [];

if (!collected.ok) {
  emit({ fetched_at: collected.fetchedAt, ok: false, error: collected.error, provider: PROVIDER, routes: out }, 1);
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
  fetched_at: collected.fetchedAt,
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
