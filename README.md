# Transit Watch

Live bus tracking and flight prices for the Cyberjaya MRT feeder routes (T504, T505)
and KBR ↔ KUL.

- **Bus tab** — Leaflet map with the route shape, stops, live vehicle positions, and
  per-stop ETAs, plus the published timetable.
- **Flights tab** — round-trip / one-way fare search with an optional cheapest-date sweep.

## Quick start

```bash
npm install
npm run dev            # API on :8787, Vite on :5173 (proxies /api)
```

Production: `npm run build && npm start` — the server serves `dist/` and the API on one port.

| env | default | meaning |
|---|---|---|
| `PORT` | `8787` | API port |
| `ROUTES` | `T504,T505` | routes the Bus tab preselects |
| `DATA_DIR` | `./data` | GTFS cache (gitignored) |

## Architecture

```
server/index.mjs        Express API — see docs/API.md for the frozen contract
server/lib/gtfs.mjs     data.gov.my GTFS static: download, cache, parse, index
server/lib/live.mjs     kiosk Socket.IO collector → vehicle positions
server/lib/eta.mjs      delay-based ETA from timetable + live position
server/lib/flights.mjs  Google Flights fetch + parse (+ 10 min cache)
web/src/                Vite + React + TypeScript + Leaflet
test/                   node:test suite, offline-safe
scrape_*.js             standalone CLIs over the same libs
```

## Data sources

| Concern | Source | Status |
|---|---|---|
| Timetable, stops, shapes, trips | [data.gov.my GTFS static](https://api.data.gov.my/gtfs-static/prasarana?category=rapid-bus-mrtfeeder) | authoritative |
| Live vehicle positions | MyRapid kiosk Socket.IO | verified working |
| Fares | Google Flights (server-rendered HTML) | verified working |

**GTFS-RT is not usable for these routes** — the feed carries ~79 vehicles but none on
T504/T505, and its `route_id` is a display name (`"T155 Inbound"`), not the static id.
That is why live positions still come from the kiosk socket.

ETAs are ours to compute: there is no trip-update feed. `server/lib/eta.mjs` snaps each
vehicle to the route shape, finds the scheduled trip that best explains its current
position, and projects that delay onto the stops ahead. Vehicles that are not serving
(`off_trip`) never produce ETAs — they stay on the map but cannot be "arriving".

### Gotchas already paid for

**GTFS static** — `routes.txt` puts the route name in `route_long_name`; `route_short_name`
is empty. Static `route_id` is numeric (`T504` = `30000150`). Stop ids served are
`stop_code` values (`SP398`). The calendar covers a rolling ~4 weeks, so the feed expires
and must be refreshed.

**Kiosk socket** — three things are required or nothing is ever pushed: open the namespace
(`40`), emit `onFts-reload` **with an ack id** (`421[...]`), and send an **inline object**
payload (not a stringified string). Answer engine.io pings (`2` → `3`). The payload is
`base64(gzip(json))`. Route codes come back as `T5040`, and `dir` is opaque.

**Google Flights** — dates must be in the future (past dates return HTTP 200 with an empty
result set). The `tfs` param is a URL-safe-base64 protobuf; **field 2 must be omitted for
one-way** or the search silently returns nothing. Labels contain a U+202F narrow no-break
space before `AM/PM`.

**MyRapid's HTML host sits behind Imperva Incapsula** — `curl`/`fetch` gets a JS challenge
there. The websocket host is not challenged, which is why the socket path works from a script.

## API

`docs/API.md` is the contract (`/api/health`, `/api/routes`, `/api/route/:name`,
`/api/route/:name/live`, `/api/flights`). It is the source of truth for shapes; both sides
of the app are built against it.

```bash
curl localhost:8787/api/health
curl localhost:8787/api/route/T504/live
curl 'localhost:8787/api/flights?from=KBR&to=KUL&out=2026-11-18&ret=2026-11-25'
```

## CLIs

Still available, same libs, JSON on stdout and diagnostics on stderr.

```bash
node scrape_buses.js   [route ...]              # name (T504) or kiosk id (1043)
node scrape_flights.js <ORIGIN> <DEST> <out> [ret] [flags]
```

| | |
|---|---|
| exit `0` | success (even if the honest answer is 0 buses / 0 fares) |
| exit `1` | scrape failed — JSON still emitted with `ok:false` and `error.reason` |
| exit `2` | bad usage |

`error.reason`: `past_date`, `http_<code>`, `blocked`, `consent_wall`, `truncated`,
`unexpected_page`, `timeout`, `network`, `empty_results`, `parse_failed` (flights);
`no_payload`, `connect`, `decode` (buses).

## Tests

```bash
npm test        # node:test — 46 tests, ~5 s
```

The suite is offline-safe: GTFS-dependent tests skip when `data/gtfs_rapid_bus_mrtfeeder.zip`
is absent, and the flight tests run against a saved HTML fixture. A stub websocket is
preloaded into the spawned API server so the live path runs without network.

## Known limitations

- **ETA accuracy is timetable-proportional.** It assumes the matched trip's shape of running
  time; a long dwell is carried forward to every stop ahead. Loop legs within ~150 m of each
  other are told apart by which implies the smaller delay, so a bus >45 min off schedule can
  snap to the wrong leg.
- **GTFS refresh** rebuilds the whole model (~1 s CPU, ~75 MB heap), checked hourly.
- **Flight scraping is fragile by nature** — it depends on Google's current DOM. The parser
  fails loudly rather than returning an empty list, so breakage is visible.
- No persistence: prices and ETAs live in memory only.
