// Fares end-to-end without the network: global fetch is replaced by a fake that
// serves the saved Google Flights page. Covers the scrape document shape, sweep
// date expansion, the 10-minute cache and the cached-but-stale fallback.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchFares, getFares, CACHE_MS } from '../server/lib/flights.mjs';

const HTML = zlib
  .gunzipSync(fs.readFileSync(new URL('./fixtures/google-flights-kbr-kul.html.gz', import.meta.url)))
  .toString('utf8');

// A page classify() rejects without retrying: blocked pages bail immediately.
const BLOCKED = '<html><body>Our systems have detected unusual traffic from your network.</body></html>';

/** Install a fake fetch; returns { calls, restore }. */
function fakeFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const res = await handler(String(url), calls.length);
    return {
      status: res.status,
      text: async () => res.body,
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ok = (body = HTML) => ({ status: 200, body });

test('searchFares: builds a one-way document from the saved page', async () => {
  const fake = fakeFetch(() => ok());
  try {
    const doc = await searchFares({ from: 'kbr', to: 'kul', out: '2099-01-10', log: () => {} });

    assert.equal(fake.calls.length, 1);
    const url = new URL(fake.calls[0].url);
    assert.equal(url.origin, 'https://www.google.com');
    assert.equal(url.pathname, '/travel/flights/search');
    assert.match(url.searchParams.get('tfs'), /^[A-Za-z0-9_-]+$/);
    assert.equal(url.searchParams.get('hl'), 'en-US');
    assert.equal(url.searchParams.get('gl'), 'US');
    assert.match(fake.calls[0].opts.headers['User-Agent'], /Mozilla\/5\.0/);

    assert.equal(doc.ok, true);
    assert.equal(doc.trip, 'one_way');
    assert.equal(doc.route, 'KBR -> KUL');
    assert.deepEqual(doc.dates, ['2099-01-10']);
    assert.equal(doc.swept_days, 1);
    assert.equal(doc.results.length, 1);
    assert.equal(doc.results[0].cards, 16);
    assert.equal(doc.results[0].parsed, 8);
    assert.equal(doc.results[0].ret, null);
    assert.equal(doc.cheapest_overall.price, 59);
    assert.equal(doc.cheapest_overall.airline, 'AirAsia');
    assert.equal(doc.cheapest_date, '2099-01-10');
    assert.match(doc.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(doc.summary, /KBR→KUL is \$59/);
  } finally {
    fake.restore();
  }
});

test('searchFares: sweep expands consecutive departure days', async () => {
  const fake = fakeFetch(() => ok());
  try {
    const doc = await searchFares({ from: 'KBR', to: 'KUL', out: '2099-01-10', sweep: 2, log: () => {} });
    assert.equal(fake.calls.length, 3, 'sweep 2 means three searches');
    assert.deepEqual(doc.results.map((r) => r.outbound), ['2099-01-10', '2099-01-11', '2099-01-12']);
    assert.equal(doc.swept_days, 3);
    assert.match(doc.summary, /Scanned 3 departure days/);
  } finally {
    fake.restore();
  }
});

test('searchFares: rejects invalid input before any fetch', async () => {
  const fake = fakeFetch(() => ok());
  try {
    await assert.rejects(
      searchFares({ from: '', to: 'KUL', out: '2099-01-10' }),
      (e) => e.reason === 'bad_request',
    );
    await assert.rejects(
      searchFares({ from: 'KBR', to: 'KUL', out: '2000-01-01' }),
      (e) => e.reason === 'past_date',
    );
    await assert.rejects(
      searchFares({ from: 'KBR', to: 'KUL', out: '2099-01-10', sweep: 32 }),
      (e) => e.reason === 'bad_request',
    );
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test('searchFares: a blocked page fails fast without retrying', async () => {
  const fake = fakeFetch(() => ({ status: 200, body: BLOCKED }));
  try {
    await assert.rejects(
      searchFares({ from: 'KBR', to: 'KUL', out: '2099-01-10', log: () => {} }),
      (e) => e.reason === 'blocked',
    );
    assert.equal(fake.calls.length, 1, 'blocked pages must not be retried');
  } finally {
    fake.restore();
  }
});

test('getFares: caches the shaped result for 10 minutes', async () => {
  const fake = fakeFetch(() => ok());
  try {
    const args = { from: 'KBR', to: 'KUL', out: '2099-02-01' };
    const first = await getFares(args);
    assert.equal(first.cached, false);
    assert.equal(first.trip, 'one_way');
    assert.equal(first.cheapestOverall.price, 59);
    assert.equal(fake.calls.length, 1);

    const second = await getFares(args);
    assert.equal(second.cached, true);
    assert.equal(second.cheapestOverall.price, 59);
    assert.equal(fake.calls.length, 1, 'a cache hit must not re-scrape');
  } finally {
    fake.restore();
  }
});

test('getFares: serves a cached entry marked stale when the fresh scrape fails', async () => {
  const args = { from: 'KBR', to: 'KUL', out: '2099-03-01' };

  const good = fakeFetch(() => ok());
  try {
    const primed = await getFares(args);
    assert.equal(primed.cached, false);
  } finally {
    good.restore();
  }

  const realNow = Date.now;
  Date.now = () => realNow() + CACHE_MS + 1; // expire the in-memory entry
  const bad = fakeFetch(() => ({ status: 200, body: BLOCKED }));
  try {
    const stale = await getFares(args);
    assert.equal(stale.cached, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.cheapestOverall.price, 59, 'the previous document is served');
  } finally {
    bad.restore();
    Date.now = realNow;
  }
});

test('getFares: a scrape failure with nothing cached rejects', async () => {
  const fake = fakeFetch(() => ({ status: 200, body: BLOCKED }));
  try {
    await assert.rejects(
      getFares({ from: 'KBR', to: 'KUL', out: '2099-04-01' }),
      (e) => e.reason === 'blocked',
    );
  } finally {
    fake.restore();
  }
});
