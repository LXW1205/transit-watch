// Google Flights fare scraping, extracted from scrape_flights.js so the CLI and the
// server share one implementation.
//
// No browser required — Google server-renders every result card into an aria-label
// attribute. Four established gotchas:
//   1. dates must be in the future; past dates return HTTP 200 with an empty result
//      set, indistinguishable from a scraping bug → checked up front ('past_date')
//   2. the `tfs` query param is URL-safe-base64 protobuf built by buildToken()
//   3. field 2 must never be emitted for a one-way search — that silently returns
//      zero results; Google infers trip type from the number of segments
//   4. Google emits U+202F between the time and AM/PM, so labels are normalised to
//      ASCII spaces *and* times are matched with \s?
//
// Two entry points:
//   searchFares(...)  the scrape, returning the CLI's document (snake_case)
//   getFares(...)     the same fares in the API contract's shape, with a 10-minute
//                     in-memory cache and cached-but-stale fallback

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

export function buildToken(outDate, retDate, from, to) {
  const segs = retDate
    ? [segment(outDate, from, to), segment(retDate, to, from)]
    : [segment(outDate, from, to)];
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
export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- fetching
export class ScrapeError extends Error {
  constructor(reason, detail, extra = {}) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

function classify(html, status) {
  if (status !== 200) return ['http_' + status, `HTTP ${status}`];
  if (/unusual traffic|detected unusual traffic|\/sorry\/index/i.test(html)) return ['blocked', 'bot challenge page'];
  if (/consent\.google\.com|Before you continue to Google/i.test(html)) return ['consent_wall', 'consent interstitial'];
  if (html.length < 20000) return ['truncated', `only ${html.length} bytes returned`];
  if (!/google flights/i.test(html)) return ['unexpected_page', 'Google Flights marker missing'];
  return null;
}

async function fetchOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
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
    if (e.name === 'AbortError') throw new ScrapeError('timeout', `no response in ${timeoutMs}ms`);
    throw new ScrapeError('network', e.cause?.message || e.message);
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(url, timeoutMs, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchOnce(url, timeoutMs); }
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

export function parseFlights(html) {
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
// Shape matches state/history.json, so the CLI can pass its file-backed store and
// the server can pass createMemoryHistory().
export function createMemoryHistory() {
  return { data: { runs: {} }, dirty: false };
}

const historyKey = (from, to, s) => `${from}-${to}|${s.ret ? 'RT' : 'OW'}|${s.outbound}|${s.ret ?? '-'}`;

// ---------------------------------------------------------------- scrape
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Scrape one origin/destination pair, optionally sweeping following departure days.
 * Returns the CLI document; throws ScrapeError (with `results`/`planned` attached)
 * when a search fails.
 */
export async function searchFares({
  from, to, out, ret = null, sweep = 0, timeoutMs = 45_000, history = null, log = () => {},
} = {}) {
  const origin = String(from || '').toUpperCase();
  const dest = String(to || '').toUpperCase();
  if (!origin || !dest) throw new ScrapeError('bad_request', 'from and to are required');
  if (!isDate(out)) throw new ScrapeError('bad_request', `bad outbound date: ${out}`);
  if (ret && !isDate(ret)) throw new ScrapeError('bad_request', `bad date: ${ret}`);
  if (!Number.isInteger(sweep) || sweep < 0 || sweep > 31) throw new ScrapeError('bad_request', 'sweep must be 0..31');

  const returnDate = ret || null;
  // dates must be in the future or Google returns an empty page with HTTP 200
  const day = today();
  if (out < day || (returnDate && returnDate < day)) {
    throw new ScrapeError('past_date', `dates must be in the future (today is ${day})`);
  }

  const tripLen = returnDate ? dayDiff(out, returnDate) : 0;
  const searches = [];
  for (let i = 0; i <= sweep; i++) {
    const departure = addDays(out, i);
    searches.push({ outbound: departure, ret: returnDate ? addDays(departure, tripLen) : null });
  }

  const now = new Date().toISOString();
  const results = [];

  for (const s of searches) {
    const url = `https://www.google.com/travel/flights/search?tfs=${buildToken(s.outbound, s.ret, origin, dest)}&hl=en-US&gl=US`;
    try {
      const { html } = await fetchWithRetry(url, timeoutMs);
      const { flights, cards, unmatched, sample } = parseFlights(html);

      if (cards === 0) throw new ScrapeError('empty_results', 'no flight cards in page');
      if (flights.length === 0) throw new ScrapeError('parse_failed', `0 of ${cards} cards matched; first label: ${sample}`);

      const prev = history?.data?.runs?.[historyKey(origin, dest, s)] || null;
      const cheapest = flights[0];
      const change = prev
        ? { previous_price: prev.price, delta: cheapest.price - prev.price, previous_fetched_at: prev.fetched_at }
        : null;

      results.push({ outbound: s.outbound, ret: s.ret, cards, parsed: flights.length, unmatched, cheapest, change, flights });

      if (history) {
        history.data.runs[historyKey(origin, dest, s)] = {
          price: cheapest.price, airline: cheapest.airline, depTime: cheapest.depTime, fetched_at: now,
        };
        history.dirty = true;
      }
      log(`flights: ${origin}-${dest} ${s.outbound}${s.ret ? '/' + s.ret : ''}: ` +
        `${flights.length} fares, cheapest $${cheapest.price} (${cheapest.airline})`);
    } catch (e) {
      const failure = e instanceof ScrapeError
        ? e
        : new ScrapeError('unexpected', e.stack || String(e));
      log(`flights: FAILED ${s.outbound}: ${failure.reason} — ${failure.detail}`);
      // a failing sweep day means the whole sweep result is untrustworthy
      throw Object.assign(failure, { results, planned: searches.length });
    }
  }

  const overall = results.reduce((a, b) => (b.cheapest.price < a.cheapest.price ? b : a), results[0]);
  const sweepNote = sweep
    ? ` Scanned ${results.length} departure day${results.length === 1 ? '' : 's'}; cheapest on ${overall.outbound}.`
    : '';

  return {
    fetched_at: now,
    ok: true,
    route: `${origin} -> ${dest}${returnDate ? ` -> ${origin}` : ''}`,
    trip: returnDate ? 'round_trip' : 'one_way',
    dates: returnDate ? [out, returnDate] : [out],
    swept_days: results.length,
    cheapest_overall: overall.cheapest,
    cheapest_date: overall.outbound,
    any_price_change: results.some(r => r.change && r.change.delta !== 0),
    summary: `Cheapest ${returnDate ? 'round trip' : 'one way'} ${origin}→${dest} is $${overall.cheapest.price} on ${overall.cheapest.airline}, ` +
      `departing ${overall.cheapest.depTime} on ${overall.outbound} (${overall.cheapest.stops.toLowerCase()}).${sweepNote}`,
    results,
  };
}

// ---------------------------------------------------------------- cache
export const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
// the server keeps change-detection in memory; the CLI persists it to state/
const memoryHistory = createMemoryHistory();

function contractShape(doc) {
  return {
    ok: true,
    cached: false,
    fetchedAt: doc.fetched_at,
    route: doc.route,
    trip: doc.trip,
    dates: doc.dates,
    sweptDays: doc.swept_days,
    cheapestOverall: doc.cheapest_overall,
    cheapestDate: doc.cheapest_date,
    summary: doc.summary,
    results: doc.results,
  };
}

function pruneCache(now) {
  for (const [key, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(key);
}

/**
 * Contract-shaped fares with a 10-minute cache keyed by the full query.
 * A cached entry is served with `stale: true` when the fresh scrape fails.
 */
export async function getFares({ from, to, out, ret = null, sweep = 0, timeoutMs = 45_000 } = {}) {
  const key = [String(from || '').toUpperCase(), String(to || '').toUpperCase(), out, ret || '', sweep].join('|');
  const entry = cache.get(key);
  const now = Date.now();
  if (entry && now - entry.at < CACHE_MS) return { ...entry.doc, cached: true };

  try {
    const doc = await searchFares({ from, to, out, ret, sweep, timeoutMs, history: memoryHistory });
    const shaped = contractShape(doc);
    if (cache.size > 64) pruneCache(now);
    cache.set(key, { at: Date.now(), doc: shaped });
    return { ...shaped, cached: false };
  } catch (e) {
    if (entry) return { ...entry.doc, cached: true, stale: true };
    throw e;
  }
}
