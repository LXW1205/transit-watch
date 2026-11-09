# Travel scrapers — bus availability + flight prices

Two self-contained Node scripts. **Zero dependencies** (Node 22+, built-in `fetch`/`WebSocket`).

```
node scrape_buses.js   [route ...]              # routes by name (T504) or kiosk id (1043)
node scrape_flights.js <ORIGIN> <DEST> <out> [ret] [flags]

node scrape_buses.js 1043 1044
node scrape_flights.js KBR KUL 2026-11-04 2026-11-18
node scrape_flights.js KBR KUL 2026-11-04 --oneway
node scrape_flights.js KBR KUL 2026-11-04 2026-11-18 --sweep 7
```

### Contract (for scheduled runs)

| | |
|---|---|
| stdout | exactly one JSON document, always |
| stderr | human-readable progress / diagnostics |
| exit `0` | scrape succeeded (even if the honest answer is 0 buses / 0 fares) |
| exit `1` | scrape failed — JSON still emitted, with `ok:false` and `error.reason` |
| exit `2` | bad usage |

`error.reason` values: `past_date`, `http_<code>`, `blocked`, `consent_wall`,
`truncated`, `unexpected_page`, `timeout`, `network`, `empty_results`,
`parse_failed` (flights); `no_payload`, `connect`, `decode` (buses).

---

## 1. Bus availability — `scrape_buses.js`

Source: `https://myrapidbus.prasarana.com.my/kiosk?route=1043&bus=, T504, T505`

The kiosk page is server-rendered (stops, route shapes, coordinates all inline), but
**live positions are not in the HTML** — they arrive over a Socket.IO push channel:

```
wss://rapidbus-socketio-avl.prasarana.com.my/socket.io/?EIO=4&transport=websocket
```

Protocol gotchas — all three are required to get any data back:

1. Open the namespace first: send `40`, wait for `40{"sid":...}`.
2. Emit `onFts-reload` **with an ack id**: `421["onFts-reload",{...}]`. Without the
   `1` the handler never invokes its callback and *nothing is ever pushed*.
3. The payload must be an **inline object**, not stringified twice.
   `421["onFts-reload","{\"sid\":...}"]` is silently accepted and yields nothing.
4. Answer Engine.IO pings: on packet `2`, reply `3`.

Payload is `base64(gzip(json))` → `zlib.gunzipSync(Buffer.from(s,'base64'))`.

**Completing a run.** The server sends one payload per emit, but a payload can't be
attributed to a route until buses in it are matched — so a route with *no buses
running* would never look "done". The script therefore finishes when every route has
a bus, else after an idle window, and treats "received ≥1 payload" as success even
if it ends with 0 buses. At 2am that is the true answer; only zero payloads within
`--timeout` is an error (`no_payload`, exit 1).

Per-bus fields: `bus_no`, `route` (e.g. `T5040`), `direction`, `lat`, `lng`,
`speed_kmh`, `status`, `gps_time`, `gps_age_s`, `live`.

`trip_rev_kind` legend (from the page's icon mapping):
`00` on_trip · `99` off_trip · `01`/`03`/`05` contingency.
GPS older than 5 min is stale — the kiosk page uses the same 5-min cutoff.

**Route aliases.** `route_ids.json` maps the kiosk's numeric ids to route names
(504 entries, parsed from the page's `<select>`): `1043 → T504`, `1044 → T505`.
Names are also accepted directly.

**Response matching.** A route name matches `^<name>\d?$`, so `T504` accepts the
variant `T5040` (name + direction digit) without letting `T50` swallow `T504`.

---

## 2. Flight prices — `scrape_flights.js`

Source: `https://www.google.com/travel/flights?gl=US&hl=en-US`

**A plain `fetch` is enough — no browser, no Playwright.** Results are server-rendered
into the HTML as `aria-label` attributes on each result card:

```
From 62 US dollars round trip total. Nonstop flight with AirAsia. Leaves Kota Bharu
Sultan Ismail Petra Airport at 10:00 AM on Wednesday, November 4 and arrives at
Kuala Lumpur International Airport at 11:10 AM ... Total duration 1 hr 10 min.
```

Four gotchas:

1. **Dates must be in the future.** Past dates return HTTP 200 with an empty result
   set — indistinguishable from a scraping bug. Checked up front (`past_date`).
2. The `tfs` query param is URL-safe-base64 protobuf describing the search; this
   script builds it (f1=28, f2=trip, f3=segment{2:date, 13:origin, 14:dest},
   f8/f9=pax, f14=cabin, f16=sentinel, f19=1).
3. **`f2=1` must never be emitted for a one-way search** — it silently returns zero
   results. Google infers trip type from the number of segments; the only value of
   f2 that works is `2`, even with a single segment. So round-trip emits `f2=2`,
   one-way omits field 2 entirely. (Probed 8 token shapes to establish this.)
4. Google emits **U+202F** (narrow no-break space) between the time and `AM/PM`.
   Normalise labels with `\s+ → ' '` *and* match times with `\s?`, or the regex
   fails on every card while still looking correct.

Duplicates are expected (Google renders each card more than once); deduped on
airline + departure time + price + stops.

### `--sweep N`

Scans N consecutive departure days, holding trip length constant (the return date
moves with the departure). Reports `cheapest_overall` / `cheapest_date` plus a
per-day breakdown. Sequential requests with a small gap.

### Change detection (`state/`)

Both scripts persist last run to `state/` and emit a delta:

```jsonc
// flights: state/history.json, keyed origin-dest|RT|out|ret
"change": { "previous_price": 67, "delta": -5, "previous_fetched_at": "..." }
// buses: state/buses.json, keyed route name
"change": { "previous_live": 3, "delta_live": 1, "previous_total": 4, "delta_total": -1, ... }
```

Top-level `any_price_change` / `any_change` flags make it trivial for a scheduled
run to say only something when it matters. Disable with `--no-history`, relocate
with `--state <path>`.

### Robustness

Retries (3×, exponential backoff) on `timeout`/`network`/`http_*`, but **not** on
`blocked`/`consent_wall` — those won't improve on retry. Each response is classified
before parsing: bot challenge, consent interstitial, truncated body, or missing
Google Flights marker all fail loudly instead of returning 0 flights.

---

## Testing notes

The MyRapid site sits behind Imperva Incapsula — `curl`/`fetch` of the *HTML* gets a
JS challenge (assets 302-loop), but the **AVL websocket host is not challenged**, so
the socket path works fine from a script. The `sid` embedded in `scrape_buses.js` was
scraped from the kiosk page and is not validated server-side.

Verified: route-id aliases, one-way, round trip, `--sweep`, history deltas on both
scripts, and every error path (past date, missing return, bad flag, unknown route id,
socket timeout) — each returns the right exit code and a valid JSON document.
