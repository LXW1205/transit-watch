# API contract — v1

Fixed contract between `server/` (backend) and `web/` (frontend). Both sides are
implemented against this document in parallel; **do not change a shape unilaterally**.

- Base path `/api`, JSON only, `Content-Type: application/json; charset=utf-8`.
- Errors: non-2xx with `{ "error": { "reason": string, "detail": string } }`.
- All times that are instants are ISO-8601 UTC (`2026-11-09T14:55:00.000Z`).
- All times that are *service* times are `HH:MM:SS` strings from GTFS, in
  `Asia/Kuala_Lumpur`, and may exceed 24:00 (GTFS convention for after-midnight trips).
- Coordinates are `[lat, lng]` tuples (Leaflet order), WGS84.

---

## Data sources

| Concern | Source | Status |
|---|---|---|
| Timetable, stops, route geometry, trips | data.gov.my GTFS static, `category=rapid-bus-mrtfeeder` | authoritative |
| Live vehicle positions | MyRapid kiosk Socket.IO (see `scrape_buses.js`) | verified working |
| Fares | Google Flights, parsed server-side (see `scrape_flights.js`) | verified working |

GTFS static is a ~2 MB zip, redirecting to
`https://openapi-malaysia-transport.s3.ap-southeast-1.amazonaws.com/prasarana/gtfs_rapid_bus_mrtfeeder.zip`.
It contains `routes.txt` (91 routes), `trips.txt` (6292), `stop_times.txt` (175 813),
`stops.txt` (2120), `shapes.txt` (35 030), `calendar.txt`, `calendar_dates.txt`.

**Gotchas already established — do not re-derive:**

- `routes.txt` puts the route name (e.g. `T504`) in **`route_long_name`**;
  `route_short_name` is empty. Static `route_id` is numeric (`T504` = `30000150`).
- `calendar.txt` covers a rolling ~4-week window (`start_date`/`end_date`), with one
  weekday service and one weekend service. Trips may therefore expire — the server
  must refresh the feed periodically and the UI must tolerate a stale feed.
- GTFS-RT (`/gtfs-realtime/vehicle-position/prasarana?category=rapid-bus-mrtfeeder`)
  is **not** usable for our routes: 79 vehicles, none on T504/T505, and its
  `route_id` is a display name (`"T155 Inbound"`) rather than the static id.
- The kiosk socket returns route codes like `T5040` (name + variant digit) and its
  own `dir` values `"00" | "01" | "02"`. Do not assume `dir` maps 1:1 to GTFS
  `direction_id`; treat it as opaque and expose it as `direction`.

---

## `GET /api/health`

```jsonc
{
  "ok": true,
  "uptimeS": 128,
  "gtfs": { "loaded": true, "fetchedAt": "2026-11-09T14:00:00.000Z", "routes": 91, "serviceValidTo": "2026-12-06" },
  "live":  { "lastAt": "2026-11-09T14:55:04.000Z", "vehicles": 3 }
}
```

`ok` is `false` (HTTP 200 still) when GTFS failed to load — the UI shows a banner.

---

## `GET /api/routes`

```jsonc
{
  "routes": [
    {
      "name": "T504",                       // user-facing, from route_long_name
      "routeId": "30000150",                // static GTFS id
      "headsigns": ["MRT CYBERJAYA UTARA - CYBER 11"],
      "stopCount": 31,
      "tripCount": 80
    }
  ],
  "default": ["T504", "T505"]               // routes the UI should preselect
}
```

Sorted by `name`. `default` comes from env `ROUTES` (comma separated), default `T504,T505`.

---

## `GET /api/route/:name`

`name` is the route long name, e.g. `T504`. 404 if unknown.

```jsonc
{
  "name": "T504",
  "routeId": "30000150",
  "directions": [
    {
      "id": 0,                                            // GTFS direction_id
      "headsign": "MRT CYBERJAYA UTARA - CYBER 11",
      "shape": [[2.9503, 101.6569], [2.9482, 101.6543]],   // polyline, may be simplified
      "stops": [
        { "seq": 1, "stopId": "SP398", "name": "MRT CYBERJAYA UTARA", "lat": 2.950286, "lng": 101.65693 }
      ],
      "trips": [
        { "tripId": "261030010059S10", "firstDeparture": "06:00:00", "lastArrival": "06:45:00", "serviceId": "26103001" }
      ]
    }
  ]
}
```

- `stops` are ordered by `stop_sequence` for that direction (use its canonical trip).
- `trips` sorted by `firstDeparture`; `serviceId` lets the UI label weekday vs weekend
  (resolve service names via the calendar; expose `serviceLabel` if convenient).
- If a direction has no shape, return `"shape": []` rather than null.

---

## `GET /api/route/:name/live`

Live positions plus per-stop ETA for one route. Polled every ~15 s by the UI.

```jsonc
{
  "route": "T504",
  "updatedAt": "2026-11-09T14:55:06.000Z",
  "stale": false,                       // true if the socket had no fresh data (>5 min)
  "vehicles": [
    {
      "busNo": "VH2531",
      "route": "T5040",                 // raw socket route code
      "direction": "02",                // raw socket dir, opaque
      "lat": 2.950908, "lng": 101.65678,
      "speedKmh": 12,
      "gpsTime": "2026-11-09 14:55:01", // raw, Asia/Kuala_Lumpur, no offset
      "ageS": 5,
      "live": true,                     // ageS <= 300, same rule as the kiosk page
      "status": "on_trip",              // on_trip | off_trip | contingency
      "directionId": 0,                 // best-effort match to a GTFS direction, else null
      "progress": 0.42,                 // 0..1 along that direction's shape, else null
      "bearing": 341.7,                 // heading of travel, degrees clockwise from north; null if unmatched
      "nextStop": { "seq": 7, "stopId": "SP400", "name": "McD EDUSPHERE", "etaMin": 3 }
    }
  ],
  "directions": [
    {
      "id": 0,
      "headsign": "MRT CYBERJAYA UTARA - CYBER 11",
      "stops": [
        { "seq": 1, "stopId": "SP398", "name": "MRT CYBERJAYA UTARA", "lat": 2.950286, "lng": 101.65693, "etaMin": null, "nextAt": null },
        { "seq": 7, "stopId": "SP400", "name": "McD EDUSPHERE", "lat": 2.933955, "lng": 101.63693, "etaMin": 3, "nextAt": "2026-11-09T14:58:00.000Z" }
      ]
    }
  ]
}
```

Rules:

- `etaMin` is `null` when no live vehicle on that direction can serve the stop now.
  Never invent a number; do not fall back to the raw timetable here (the UI shows the
  timetable separately).
- `etaMin` is whole minutes, `>= 0`, and is the *soonest* arrival among live vehicles.
- A vehicle with `live: false` must not produce an ETA.
- If the socket is unreachable, return HTTP 200 with `vehicles: []`, `stale: true`,
  and `directions` intact (ETAs all `null`). The map keeps working, the ETA column empties.
- `updatedAt` is when the data was collected, not when the request arrived.

### ETA method

Delay-based, computed from the GTFS timetable plus the live position:

1. Snap the vehicle to the direction's shape (nearest segment) → `progress` along it.
2. Pick the candidate trip whose scheduled position is closest to now for that direction.
3. The vehicle's current delay = now − (scheduled time at the snapped position).
4. For each stop ahead of the vehicle: `eta = scheduledArrival + delay`, clamped to
   `>= now`. The soonest across live vehicles wins.

If step 2 is ambiguous (e.g. several trips overlap), pick the one minimising
`|delay|`. Keep the implementation total and cheap: no per-request O(n²) over 175k rows.

### Heading

`bearing` is the direction of travel at the vehicle's projection, taken from the
tangent of the route shape — not from GPS. The kiosk feed carries no heading, and a
GPS-derived one jitters badly at stops where the bus is stationary; the geometry is
stable and always agrees with the drawn line. `null` when the vehicle could not be
snapped to a shape.

---

## `GET /api/flights`

Query: `from`, `to` (IATA), `out` (`YYYY-MM-DD`), `ret` (`YYYY-MM-DD`, omit for
one-way), `sweep` (int 0..7, default 0). Dates must be in the future.

Response mirrors the existing CLI output so the logic can be shared, wrapped with cache
metadata:

```jsonc
{
  "ok": true,
  "cached": false,
  "fetchedAt": "2026-11-09T14:55:06.000Z",
  "route": "KBR -> KUL -> KBR",
  "trip": "round_trip",
  "dates": ["2026-11-18", "2026-11-25"],
  "sweptDays": 1,
  "cheapestOverall": { "price": 80, "stops": "Nonstop", "airline": "Malaysia Airlines" },
  "cheapestDate": "2026-11-18",
  "summary": "Cheapest round trip KBR→KUL is $80 on Malaysia Airlines ...",
  "results": [
    {
      "outbound": "2026-11-18",
      "ret": "2026-11-25",
      "url": "https://www.google.com/travel/flights/search?tfs=...&hl=en-US&gl=US",
      "cards": 16, "parsed": 8,
      "cheapest": {
        "price": 62, "stops": "Nonstop", "airline": "AirAsia",
        "depAirport": "...", "depTime": "10:00 AM", "depDate": "Wednesday, November 18",
        "arrAirport": "...", "arrTime": "11:10 AM", "arrDate": "...",
        "duration": "1 hr 10 min", "roundTrip": true
      },
      "change": null,       // { previous_price, delta, previous_fetched_at } when known
      "flights": [ /* same objects as `cheapest` */ ]
    }
  ]
}
```

Cache successful responses in memory for 10 minutes keyed by the full query; on a
scrape failure return HTTP 502 with the error envelope. A cached-but-stale entry may be
served with `"cached": true` and a `"stale": true` marker if the fresh fetch fails.

`results[].url` is the exact Google Flights search that produced that date's fares — the
same `tfs` token the server scraped. It is the provenance link the UI shows next to each
price: Google does not expose a stable per-itinerary URL, so a fare links to its dated
search rather than to the individual flight.

---

## Conventions

- No new runtime dependencies beyond those in `package.json`
  (`express`, `fflate`, `leaflet`, `react`, `react-dom`).
- Server reads config from env: `PORT` (default 8787), `ROUTES` (default `T504,T505`),
  `DATA_DIR` (default `./data`).
- The server must start and serve `/api/health` even with no network.
- Frontend must render an explicit loading and error state for every panel; no
  spinner-forever.
