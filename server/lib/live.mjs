// MyRapid kiosk AVL socket collector — live bus positions for the MRT feeder routes.
//
//   import { collectPositions } from './lib/live.mjs';
//   const { ok, error, fetchedAt, routes } = await collectPositions(['T504'], { timeoutMs: 20000 });
//
// Importing this module does nothing: it opens a socket only when called, and every
// call owns its own socket and timers, so concurrent callers cannot interfere.
//
// The protocol, all of it required (see README.md for the write-up):
//   1. wss://rapidbus-socketio-avl.prasarana.com.my/socket.io/?EIO=4&transport=websocket
//   2. open the namespace: send "40", wait for '40{"sid":...}'
//   3. emit 'onFts-reload' WITH an ack id: '421["onFts-reload",{...}]'
//      - without the ack id the handler's callback is never invoked → no data, ever
//      - the payload must be an inline object, not a stringified string
//   4. server replies 'onFts-client' with base64(gzip(json))
//   5. answer Engine.IO pings: on '2', reply '3'
//
// A run that receives payloads is a success even if it ends with 0 buses: at night
// that is the true answer. Only zero payloads within the timeout is an error.

import zlib from 'node:zlib';

export const PROVIDER = 'RKL';
export const AVL_URL = 'https://rapidbus-socketio-avl.prasarana.com.my/socket.io/?EIO=4&transport=websocket';
// session id scraped from https://myrapidbus.prasarana.com.my/kiosk?route=1043
// (not validated server-side; the HTML host sits behind Incapsula but this
// websocket host does not, which is why the socket path works from a script)
const PAGE_SID = 'tv87hhbjs4ppcknvr5b41m1nmqcg0gea';

// trip_rev_kind legend, taken from the kiosk page's icon mapping
const STATUS = { '00': 'on_trip', '99': 'off_trip', '01': 'contingency', '03': 'contingency', '05': 'contingency' };

// "T504" should match route "T504" or the variant "T5040" (name + direction digit),
// but must NOT let "T50" swallow "T504".
export const routeMatches = (actual, name) =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d?$`).test(String(actual || ''));

// GPS fixes older than 5 min are stale — the kiosk page uses the same cutoff.
export const LIVE_AGE_S = 300;

/**
 * Collect live positions for `routes` (route names such as T504).
 * Resolves — never rejects — with
 *   { ok, error: { reason, detail } | null, fetchedAt, routes: { T504: { buses: [...] } } }
 * Each bus record:
 *   { bus_no, route, direction, lat, lng, speed_kmh, status, gps_time, gps_age_s, live }
 */
export function collectPositions(routes, { timeoutMs = 30_000, log = () => {} } = {}) {
  const names = [...new Set(routes)];
  const collectedAt = Date.now();
  const out = Object.fromEntries(names.map((r) => [r, { buses: [] }]));

  return new Promise((resolve) => {
    let ws;
    let ackId = 0;
    let settled = false;
    let receivedPayloads = 0;
    let idleTimer = null;
    let error = null;

    const timer = setTimeout(() => finish(receivedPayloads === 0
      ? { reason: 'no_payload', detail: `no data from the AVL socket within ${timeoutMs}ms` }
      : null), timeoutMs);

    function finish(err) {
      if (settled) return;
      settled = true;
      error = err;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      try { ws?.close(); } catch { /* already gone */ }
      resolve({
        ok: !err,
        error: err ? { reason: err.reason, detail: err.detail } : null,
        fetchedAt: new Date().toISOString(),
        routes: out,
      });
    }

    try {
      ws = new WebSocket(AVL_URL);
    } catch (e) {
      finish({ reason: 'connect', detail: e.message });
      return;
    }

    ws.addEventListener('error', (e) => finish({ reason: 'connect', detail: String(e.message || e) }));

    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (raw[0] === '0') { ws.send('40'); return; }             // engine.io OPEN → socket.io CONNECT
      if (raw[0] === '2') { ws.send('3'); return; }              // engine.io PING → PONG
      if (raw.startsWith('40')) {                                // namespace open → subscribe
        setTimeout(() => {
          for (const route of names) {
            const payload = { sid: PAGE_SID, uid: '', provider: PROVIDER, route };
            ws.send(`42${++ackId}["onFts-reload",${JSON.stringify(payload)}]`);
            log(`live: subscribed to ${route}`);
          }
        }, 300);
        return;
      }
      if (raw[0] === '4' && raw[1] === '3') return;              // socket.io ACK
      if (raw[0] !== '4' || raw[1] !== '2') return;

      let args;
      try { args = JSON.parse(raw.slice(2)); } catch { return; }
      if (args[0] !== 'onFts-client') return;

      let data;
      try {
        data = JSON.parse(zlib.gunzipSync(Buffer.from(args[1], 'base64')).toString('utf8'));
      } catch (e) {
        finish({ reason: 'decode', detail: `gunzip/parse failed: ${e.message}` });
        return;
      }
      receivedPayloads++;

      for (const b of Object.values(data)) {
        if (!b || !b.bus_no) continue;
        const target = names.find((r) => routeMatches(b.route, r));
        if (!target) continue;
        const gpsMs = Date.parse(String(b.dt_gps).replace(' ', 'T') + '+08:00');
        const ageS = Number.isNaN(gpsMs) ? null : Math.max(0, Math.round((collectedAt - gpsMs) / 1000));
        const rec = {
          bus_no: b.bus_no,
          route: b.route,
          direction: b.dir,
          lat: b.latitude,
          lng: b.longitude,
          speed_kmh: Number(b.speed) || 0,
          status: STATUS[b.trip_rev_kind] || `unknown(${b.trip_rev_kind})`,
          gps_time: b.dt_gps,
          gps_age_s: ageS,
          live: ageS !== null && ageS <= LIVE_AGE_S,
        };
        const bucket = out[target].buses;
        const i = bucket.findIndex((x) => x.bus_no === rec.bus_no);
        if (i >= 0) bucket[i] = rec; else bucket.push(rec);
      }

      // The server sends one payload per onFts-reload, but we can't attribute a
      // payload to a route until we match buses from it — so a route with no buses
      // running would otherwise never look "done". Finish once every requested
      // route has at least one bus, otherwise fall back to an idle window.
      clearTimeout(idleTimer);
      if (names.every((r) => out[r].buses.length > 0)) {
        idleTimer = setTimeout(() => finish(null), 400);
      } else {
        idleTimer = setTimeout(() => finish(null), receivedPayloads >= names.length ? 1500 : 5000);
      }
    });
  });
}
