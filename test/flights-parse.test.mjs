// Offline parse of a saved Google Flights results page. The fixture is a real
// server-rendered response (KBR→KUL, one-way, captured 2026-11-09), gzipped so it
// is ~300 KB in the repo instead of 2.2 MB. No network is used: the only thing
// under test is parseFlights().

import fs from 'node:fs';
import zlib from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlights } from '../server/lib/flights.mjs';

const FIXTURE = new URL('./fixtures/google-flights-kbr-kul.html.gz', import.meta.url);
const HTML = zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8');

const TIME_RE = /^\d{1,2}:\d{2} [AP]M$/; // ASCII space: U+202F must have been normalised
const DEDUPE_KEY = (f) => `${f.airline}|${f.depTime}|${f.price}|${f.stops}`;

// Known counts for this exact fixture: 16 result cards, deduped to 8 fares.
const EXPECTED_CARDS = 16;
const EXPECTED_FARES = 8;

test('fixture is the real Google Flights page, not a synthetic stub', () => {
  assert.ok(HTML.length > 1_000_000, `raw page should be ~2 MB, got ${HTML.length}`);
  assert.match(HTML, /google flights/i);
  assert.doesNotMatch(HTML, /consent\.google\.com|Before you continue to Google/i);
});

test('parseFlights: known card and unique-fare counts', () => {
  const { flights, cards, unmatched } = parseFlights(HTML);
  assert.equal(cards, EXPECTED_CARDS, 'aria-label fare cards on the page');
  assert.equal(unmatched, 0, 'every card must match the label grammar');
  assert.equal(flights.length, EXPECTED_FARES, 'unique fares after dedupe');
});

test('parseFlights: every fare is plausible', () => {
  const { flights } = parseFlights(HTML);
  for (const f of flights) {
    assert.ok(Number.isInteger(f.price), `price is not an int: ${f.price}`);
    assert.ok(f.price > 0, `price must be positive: ${f.price}`);
    assert.equal(typeof f.stops, 'string');
    assert.match(f.stops, /^(Nonstop|\d+ stops?)$/);
    assert.equal(typeof f.airline, 'string');
    assert.ok(f.airline.trim().length > 0, 'airline must be non-empty');
    assert.match(f.depTime, TIME_RE, `bad departure time: ${JSON.stringify(f.depTime)}`);
    assert.match(f.arrTime, TIME_RE, `bad arrival time: ${JSON.stringify(f.arrTime)}`);
    assert.ok(f.depAirport.trim().length > 0, 'departure airport must be non-empty');
    assert.ok(f.arrAirport.trim().length > 0, 'arrival airport must be non-empty');
    assert.ok(f.depDate.trim().length > 0, 'departure date must be non-empty');
    assert.ok(f.duration.trim().length > 0, 'duration must be non-empty');
    assert.equal(typeof f.roundTrip, 'boolean');
    assert.equal('trip' in f, false, 'the raw trip text must not leak into a fare');
  }
});

test('parseFlights: results are deduped and sorted cheapest-first', () => {
  const { flights } = parseFlights(HTML);
  const keys = new Set(flights.map(DEDUPE_KEY));
  assert.equal(keys.size, flights.length, 'dedupe key must be unique');

  const prices = flights.map((f) => f.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), 'must sort ascending');

  // Cheapest fare on this page is AirAsia at $59; the parser's first row is it.
  assert.equal(flights[0].price, 59);
  assert.equal(flights[0].airline, 'AirAsia');
  assert.equal(flights[0].stops, 'Nonstop');
});

test('parseFlights: normalises U+202F before AM/PM', () => {
  // Real Google HTML separates the time from AM/PM with a narrow no-break space.
  assert.ok(HTML.includes('\u202f'), 'fixture should contain U+202F (proves the normalisation matters)');
  const { flights } = parseFlights(HTML);
  assert.ok(flights.every((f) => !f.depTime.includes('\u202f')));
});

test('parseFlights: a page with no fare labels yields zero cards, not a throw', () => {
  const { flights, cards, sample } = parseFlights('<html><body>no results</body></html>');
  assert.deepEqual(flights, []);
  assert.equal(cards, 0);
  assert.equal(sample, null);
});
