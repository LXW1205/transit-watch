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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const NOW = new Date().toISOString();

// dates must be in the future or Google returns an empty page with HTTP 200
const today = new Date().toISOString().slice(0, 10);
if (OUT_DATE < today || (RETURN && RETURN < today)) {
  emit(failure('past_date', `dates must be in the future (today is ${today})`), 1);
}

// ---------------------------------------------------------------- protobuf tfs
const varint = (n) => {
  const out = [];
  for (;;) { const b = n & 0x7f; n = Math.floor(n / 128); out.push(n ? b | 0x80 : b); if (!n) break; }
  return Buffer.from(out);
};
const tag = (f, w) => varint((f << 3) | w);
const fStr = (f, s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([tag(f, 2), varint(b.length), b]); };
const fVar = (f, n) => Buffer.concat([tag(f, 0), varint(n)]);
const fMsg = (f, inner) => Buffer.concat([tag(f, 2), varint(inner.length), inner]);
const segment = (date, from, to) => fMsg(3, Buffer.concat([fStr(2, date), fMsg(13, fStr(2, from)), fMsg(14, fStr(2, to))]));

function buildToken(outDate, retDate) {
  const segs = retDate
    ? [segment(outDate, ORIGIN, DEST), segment(retDate, DEST, ORIGIN)]
    : [segment(outDate, ORIGIN, DEST)];
  // Field 2 must NOT be emitted for a one-way search: f2=1 yields an empty
  // result set. Google infers trip type from the number of segments, and the
  // only value of f2 that returns results is 2 (round trip) — including when
  // there is a single segment.
  const head = retDate ? [fVar(1, 28), fVar(2, 2)] : [fVar(1, 28)];
  return Buffer.concat([
    ...head,
    ...segs,
    fVar(8, 1), fVar(9, 1),     // passengers
    fVar(14, 1),                // cabin: economy
    // field 16 { field 1 = max uint64 } — sentinel seen in Google's own tokens
    fMsg(16, Buffer.concat([tag(1, 0), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])])),
    fVar(19, 1),
  ]).toString('base64url');
}

// ---------------------------------------------------------------- dates
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const tripLen = RETURN ? dayDiff(OUT_DATE, RETURN) : 0;
const searches = [];
for (let i = 0; i <= flags.sweep; i++) {
  const out = addDays(OUT_DATE, i);
  searches.push({ outbound: out, ret: RETURN ? addDays(out, tripLen) : null });
}

// ---------------------------------------------------------------- fetching
class ScrapeError extends Error {
  constructor(reason, detail) { super(`${reason}: ${detail}`); this.reason = reason; this.detail = detail; }
}

function classify(html, status) {
  if (status !== 200) return ['http_' + status, `HTTP ${status}`];
  if (/unusual traffic|detected unusual traffic|\/sorry\/index/i.test(html)) return ['blocked', 'bot challenge page'];
  if (/consent\.google\.com|Before you continue to Google/i.test(html)) return ['consent_wall', 'consent interstitial'];
  if (html.length < 20000) return ['truncated', `only ${html.length} bytes returned`];
  if (!/google flights/i.test(html)) return ['unexpected_page', 'Google Flights marker missing'];
  return null;
}

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), flags.timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = await res.text();
    const problem = classify(html, res.status);
    if (problem) throw new ScrapeError(problem[0], problem[1]);
    return { html, status: res.status };
  } catch (e) {
    if (e instanceof ScrapeError) throw e;
    if (e.name === 'AbortError') throw new ScrapeError('timeout', `no response in ${flags.timeout}ms`);
    throw new ScrapeError('network', e.cause?.message || e.message);
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchOnce(url); }
    catch (e) {
      last = e;
      // blocked/consent pages will not improve on retry — bail immediately
      if (e.reason === 'blocked' || e.reason === 'consent_wall') break;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

// ---------------------------------------------------------------- parsing
const LABEL_RE = /aria-label="(From [^"]+?dollars[^"]*?)"/g;
// Google puts a U+202F NARROW NO-BREAK SPACE before AM/PM in the raw HTML; labels
// are normalised to ASCII spaces below, so match times with \s? not a literal space.
const FLIGHT_RE = /^From (?<price>[\d,]+) US dollars (?<trip>[^.]+?)\. (?<stops>Nonstop|\d+ stops?|[A-Za-z][A-Za-z ]*?) flight with (?<airline>[^.]+?)(?:\. Operated by (?<operated>[^.]+?))?\. Leaves (?<depAirport>[^.]+?) at (?<depTime>\d{1,2}:\d{2}\s?[AP]M) on (?<depDate>.+?) and arrives at (?<arrAirport>[^.]+?) at (?<arrTime>\d{1,2}:\d{2}\s?[AP]M)(?: on (?<arrDate>.+?))?\. Total duration (?<duration>.+?)\./;

function parseFlights(html) {
  const labels = [...html.matchAll(LABEL_RE)]
    .map(m => m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
  const flights = [];
  const seen = new Set();
  let unmatched = 0;
  for (const label of labels) {
    const m = FLIGHT_RE.exec(label);
    if (!m) { unmatched++; continue; }
    const f = m.groups;
    f.price = Number(f.price.replace(/,/g, ''));
    f.roundTrip = /round trip/i.test(f.trip);
    delete f.trip;
    const key = `${f.airline}|${f.depTime}|${f.price}|${f.stops}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flights.push(f);
  }
  flights.sort((a, b) => a.price - b.price);
  return { flights, cards: labels.length, unmatched, sample: labels[0] || null };
}

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
const historyKey = (s) => `${ORIGIN}-${DEST}|${s.ret ? 'RT' : 'OW'}|${s.outbound}|${s.ret ?? '-'}`;

// ---------------------------------------------------------------- emit helpers
function emit(doc, code) {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  process.exit(code);
}
function failure(reason, detail, extra = {}) {
  return { fetched_at: NOW, ok: false, error: { reason, detail }, ...extra };
}

// ---------------------------------------------------------------- main
const history = loadHistory();
const results = [];
let failure_ = null;

for (const s of searches) {
  const url = `https://www.google.com/travel/flights/search?tfs=${buildToken(s.outbound, s.ret)}&hl=en-US&gl=US`;
  try {
    const { html } = await fetchWithRetry(url);
    const { flights, cards, unmatched, sample } = parseFlights(html);

    if (cards === 0) throw new ScrapeError('empty_results', 'no flight cards in page');
    if (flights.length === 0) throw new ScrapeError('parse_failed', `0 of ${cards} cards matched; first label: ${sample}`);

    const key = historyKey(s);
    const prev = history.data.runs[key] || null;
    const cheapest = flights[0];
    const change = prev
      ? { previous_price: prev.price, delta: cheapest.price - prev.price, previous_fetched_at: prev.fetched_at }
      : null;

    results.push({
      outbound: s.outbound, ret: s.ret,
      cards, parsed: flights.length, unmatched,
      cheapest, change, flights,
    });

    history.data.runs[key] = { price: cheapest.price, airline: cheapest.airline, depTime: cheapest.depTime, fetched_at: NOW };
    history.dirty = true;
    process.stderr.write(`[flights] ${ORIGIN}-${DEST} ${s.outbound}${s.ret ? '/' + s.ret : ''}: ${flights.length} fares, cheapest $${cheapest.price} (${cheapest.airline})\n`);
  } catch (e) {
    failure_ = e.reason
      ? { reason: e.reason, detail: e.detail }
      : { reason: 'unexpected', detail: e.stack || String(e) };
    process.stderr.write(`[flights] FAILED ${s.outbound}: ${failure_.reason} — ${failure_.detail}\n`);
    break;   // a failing sweep day means the whole sweep result is untrustworthy
  }
}

saveHistory(history);

if (failure_) {
  emit(failure(failure_.reason, failure_.detail, {
    route: `${ORIGIN} -> ${DEST}${RETURN ? ` -> ${ORIGIN}` : ''}`,
    completed_searches: results.length,
    planned_searches: searches.length,
    results,
  }), 1);
}

const overall = results.reduce((a, b) => (b.cheapest.price < (a?.cheapest.price ?? Infinity) ? b : a), null);
const sweepNote = flags.sweep
  ? ` Scanned ${results.length} departure day${results.length === 1 ? '' : 's'}; cheapest on ${overall.outbound}.`
  : '';

emit({
  fetched_at: NOW,
  ok: true,
  route: `${ORIGIN} -> ${DEST}${RETURN ? ` -> ${ORIGIN}` : ''}`,
  trip: RETURN ? 'round_trip' : 'one_way',
  dates: RETURN ? [OUT_DATE, RETURN] : [OUT_DATE],
  swept_days: results.length,
  cheapest_overall: overall.cheapest,
  cheapest_date: overall.outbound,
  any_price_change: results.some(r => r.change && r.change.delta !== 0),
  summary: `Cheapest ${RETURN ? 'round trip' : 'one way'} ${ORIGIN}→${DEST} is $${overall.cheapest.price} on ${overall.cheapest.airline}, ` +
    `departing ${overall.cheapest.depTime} on ${overall.outbound} (${overall.cheapest.stops.toLowerCase()}).${sweepNote}`,
  results,
}, 0);
