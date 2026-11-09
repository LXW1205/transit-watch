// Pure helpers in live.mjs. Importing the module opens no socket; the risky logic
// here is routeMatches(), which decides whether a kiosk route code belongs to a
// route (T504 must accept T5040, but not T50410 or another route).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { routeMatches, LIVE_AGE_S } from '../server/lib/live.mjs';

test('routeMatches: accepts the base name and one variant digit', () => {
  assert.equal(routeMatches('T504', 'T504'), true);
  assert.equal(routeMatches('T5040', 'T504'), true);
  assert.equal(routeMatches('T5041', 'T504'), true);
  assert.equal(routeMatches('T5049', 'T504'), true);
});

test('routeMatches: rejects other routes, extra digits and junk', () => {
  assert.equal(routeMatches('T5050', 'T504'), false);
  assert.equal(routeMatches('T50410', 'T504'), false);
  assert.equal(routeMatches('X5040', 'T504'), false);
  assert.equal(routeMatches('', 'T504'), false);
  assert.equal(routeMatches(null, 'T504'), false);
  assert.equal(routeMatches('t5040', 'T504'), false, 'codes are case-sensitive');
});

test('routeMatches: escapes regex metacharacters in the route name', () => {
  assert.equal(routeMatches('A.B0', 'A.B'), true);
  assert.equal(routeMatches('AXB0', 'A.B'), false, 'the dot must be literal');
  assert.equal(routeMatches('A+B', 'A+B'), true);
});

test('LIVE_AGE_S: matches the kiosk page 5-minute freshness rule', () => {
  assert.equal(LIVE_AGE_S, 300);
});
