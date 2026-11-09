#!/usr/bin/env node
// Scrape Google Flights fares. No browser required — Google server-renders every
// result card into an aria-label attribute.
//
//   node scrape_flights.js <ORIGIN> <DEST> <outbound YYYY-MM-DD> [return YYYY-MM-DD] [flags]
//   node scrape_flights.js KBR KUL 2026-11-04 2026-11-18
//   node scrape_flights.js KBR KUL 2026-11-04 --oneway
//   node scrape_flights.js KBR KUL 2026-11-04 2026-11-18 --sweep 7
//
// flags:
//   --oneway          one-way trip (return date must be omitted)
//   --sweep N         also scan the N-1 following departure days; trip length is
//                     held constant, so the return date moves with the departure
//   --no-history      do not read or write change-detection state
//   --state <path>    state file (default: <script dir>/state/history.json)
//   --timeout <ms>    per-request timeout (default 45000)
//
// Contract: the ONLY thing on stdout is one JSON document. Diagnostics go to
// stderr. Exit codes: 0 = ok, 1 = scrape failed, 2 = bad usage.
//
// The scrape itself lives in server/lib/flights.mjs so the API shares it; this file
// is the CLI around it: argument parsing, history file and exit codes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchFares, ScrapeError } from './server/lib/flights.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- usage / args
const argv = process.argv.slice(2);
const flags = { oneway: false, sweep: 0, history: true, state: path.join(SCRIPT_DIR, 'state', 'history.json'), timeout: 45000 };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--oneway') flags.oneway = true;
  else if (a === '--no-history') flags.history = false;
  else if (a === '--sweep') flags.sweep = Number(argv[++i]);
  else if (a === '--state') flags.state = argv[++i];
  else if (a === '--timeout') flags.timeout = Number(argv[++i]);
  else if (a.startsWith('--')) fail_usage(`unknown flag: ${a}`);
  else pos.push(a);
}
const [ORIGIN, DEST, OUT_DATE, RET_DATE] = pos;

function fail_usage(msg) {
  process.stderr.write(`${msg}\n`);
  process.stderr.write('usage: node scrape_flights.js <ORIGIN> <DEST> <outbound YYYY-MM-DD> [return YYYY-MM-DD] [--oneway] [--sweep N]\n');
  process.exit(2);
}

if (!ORIGIN || !DEST || !OUT_DATE) fail_usage('missing origin, destination or outbound date');
if (!/^\d{4}-\d{2}-\d{2}$/.test(OUT_DATE)) fail_usage(`bad outbound date: ${OUT_DATE}`);
if (RET_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(RET_DATE)) fail_usage(`bad return date: ${RET_DATE}`);
if (flags.oneway && RET_DATE) fail_usage('--oneway was given together with a return date');
if (!flags.oneway && !RET_DATE) fail_usage('return date required unless --oneway');
if (!Number.isInteger(flags.sweep) || flags.sweep < 0 || flags.sweep > 31) fail_usage('--sweep must be 0..31');

const RETURN = flags.oneway ? null : RET_DATE;
const ROUTE = `${ORIGIN} -> ${DEST}${RETURN ? ` -> ${ORIGIN}` : ''}`;

// ---------------------------------------------------------------- history
function loadHistory() {
  if (!flags.history) return { data: { runs: {} }, dirty: false };
  try {
    const data = JSON.parse(fs.readFileSync(flags.state, 'utf8'));
    if (data && typeof data === 'object' && data.runs) return { data, dirty: false };
  } catch { /* first run, or corrupt — start fresh */ }
  return { data: { runs: {} }, dirty: false };
}
function saveHistory({ data }) {
  if (!flags.history) return;
  fs.mkdirSync(path.dirname(flags.state), { recursive: true });
  fs.writeFileSync(flags.state, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------- emit helpers
function emit(doc, code) {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  process.exit(code);
}
function failure(reason, detail, extra = {}) {
  return { fetched_at: new Date().toISOString(), ok: false, error: { reason, detail }, ...extra };
}

// ---------------------------------------------------------------- main
const history = loadHistory();

try {
  const doc = await searchFares({
    from: ORIGIN,
    to: DEST,
    out: OUT_DATE,
    ret: RETURN,
    sweep: flags.sweep,
    timeoutMs: flags.timeout,
    history,
    log: (msg) => process.stderr.write(`[flights] ${msg}\n`),
  });

  saveHistory(history);

  emit({
    fetched_at: doc.fetched_at,
    ok: true,
    route: doc.route,
    trip: doc.trip,
    dates: doc.dates,
    swept_days: doc.swept_days,
    cheapest_overall: doc.cheapest_overall,
    cheapest_date: doc.cheapest_date,
    any_price_change: doc.any_price_change,
    summary: doc.summary,
    results: doc.results,
  }, 0);
} catch (e) {
  const err = e instanceof ScrapeError ? e : new ScrapeError('unexpected', e.stack || String(e));
  process.stderr.write(`[flights] FAILED: ${err.reason} — ${err.detail}\n`);
  saveHistory(history);
  emit(failure(err.reason, err.detail, {
    route: ROUTE,
    completed_searches: err.results?.length ?? 0,
    planned_searches: err.planned ?? flags.sweep + 1,
    results: err.results ?? [],
  }), 1);
}
