// The `tfs` query parameter is URL-safe-base64 protobuf. These tests decode the
// bytes buildToken() produces — they do not trust its shape — because a wrong
// field silently returns zero fares from Google with HTTP 200.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildToken } from '../server/lib/flights.mjs';

// ---------------------------------------------------------------- protobuf decoder
function readVarint(buf, i) {
  let value = 0;
  let shift = 0;
  for (;;) {
    assert.ok(i < buf.length, 'truncated varint');
    const byte = buf[i++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    assert.ok(shift <= 63, 'varint is implausibly long');
    if (!(byte & 0x80)) return [value, i];
  }
}

/** Generic protobuf → [{ field, wire, value }], value is number | Buffer. */
function decodeMessage(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag;
    [tag, i] = readVarint(buf, i);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;

    if (wire === 0) {
      let value;
      [value, i] = readVarint(buf, i);
      out.push({ field, wire, value });
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      assert.ok(i + len <= buf.length, `field ${field}: length ${len} exceeds buffer`);
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) {
      out.push({ field, wire });
      i += 8;
    } else if (wire === 5) {
      out.push({ field, wire });
      i += 4;
    } else {
      assert.fail(`unsupported wire type ${wire} for field ${field}`);
    }
  }
  return out;
}

const utf8 = (buf) => Buffer.from(buf).toString('utf8');

function segmentFields(segBuf) {
  const top = decodeMessage(segBuf);
  const get = (n) => top.find((f) => f.field === n);
  const msgText = (n) => utf8(decodeMessage(get(n).value).find((f) => f.field === 2).value);
  return {
    date: utf8(get(2).value),
    from: msgText(13),
    to: msgText(14),
    fields: top,
  };
}

function decodeToken(token) {
  // base64url only — no '+' or '/' or '=' padding in the wire format
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'token must be unpadded base64url');
  const fields = decodeMessage(Buffer.from(token, 'base64url'));
  return {
    fields,
    segments: fields.filter((f) => f.field === 3).map((f) => segmentFields(f.value)),
    tripType: fields.filter((f) => f.field === 2).map((f) => f.value),
  };
}

// ---------------------------------------------------------------- round trip
test('buildToken: round trip carries two field-3 segments, out then back', () => {
  const { segments, tripType, fields } = decodeToken(
    buildToken('2026-12-18', '2026-12-25', 'KBR', 'KUL'),
  );

  assert.equal(segments.length, 2, 'a round trip must emit exactly two segments');
  assert.deepEqual(tripType, [2], 'field 2 must be exactly 2 (Google returns nothing otherwise)');
  assert.equal(fields.filter((f) => f.field === 3).length, 2);

  // Segment 1: outbound KBR→KUL on the out date.
  assert.deepEqual(
    { date: segments[0].date, from: segments[0].from, to: segments[0].to },
    { date: '2026-12-18', from: 'KBR', to: 'KUL' },
  );
  // Segment 2: the return leg, airports reversed, on the ret date.
  assert.deepEqual(
    { date: segments[1].date, from: segments[1].from, to: segments[1].to },
    { date: '2026-12-25', from: 'KUL', to: 'KBR' },
  );
});

test('buildToken: round trip keeps the fixed passengers/cabin/sentinel fields', () => {
  const { fields } = decodeToken(buildToken('2026-12-18', '2026-12-25', 'KBR', 'KUL'));
  const varints = Object.fromEntries(
    fields.filter((f) => f.wire === 0 && f.field !== 1).map((f) => [f.field, f.value]),
  );
  assert.equal(fields.find((f) => f.field === 1)?.value, 28, 'field 1 = 28');
  assert.equal(varints[8], 1, 'one passenger (field 8)');
  assert.equal(varints[9], 1, 'one passenger (field 9)');
  assert.equal(varints[14], 1, 'economy cabin (field 14)');
  assert.equal(varints[19], 1, 'field 19 = 1');
  assert.ok(fields.some((f) => f.field === 16 && f.wire === 2), 'field 16 message present');
});

// ---------------------------------------------------------------- one way
test('buildToken: one-way emits one segment and NO field 2', () => {
  const { segments, tripType, fields } = decodeToken(
    buildToken('2026-12-18', null, 'KBR', 'KUL'),
  );

  assert.equal(segments.length, 1, 'one-way must emit exactly one segment');
  assert.equal(fields.filter((f) => f.field === 3).length, 1);
  // This is the regression: emitting field 2 (f2=1) for a one-way search made
  // Google return an empty result set with HTTP 200.
  assert.deepEqual(tripType, [], 'field 2 must be absent for a one-way search');
  assert.deepEqual(
    { date: segments[0].date, from: segments[0].from, to: segments[0].to },
    { date: '2026-12-18', from: 'KBR', to: 'KUL' },
  );
});

test('buildToken: an empty return date is treated as one-way', () => {
  const { segments, tripType } = decodeToken(buildToken('2026-12-18', '', 'KBR', 'KUL'));
  assert.equal(segments.length, 1);
  assert.deepEqual(tripType, []);
});

test('buildToken: output is deterministic for the same query', () => {
  const a = buildToken('2026-12-18', '2026-12-25', 'KBR', 'KUL');
  const b = buildToken('2026-12-18', '2026-12-25', 'KBR', 'KUL');
  assert.equal(a, b);
});
