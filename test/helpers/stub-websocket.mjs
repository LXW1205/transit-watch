// Preloaded into the spawned API server (`node --import <this> server/index.mjs`)
// so /api/route/:name/live never touches the real MyRapid AVL socket.
//
// It speaks just enough of the Engine.IO / Socket.IO handshake that live.mjs
// expects: OPEN → "40", namespace open → "40{sid}", then it answers each
// onFts-reload subscription with one onFts-client payload carrying a bus on
// T504 and one on T505, positioned on their shapes and freshly time-stamped.
// The server then computes real ETAs from its own GTFS copy — the only fake is
// the transport.

import zlib from 'node:zlib';

// Mid-shape points taken from the cached feed (shape[30%]) so snapping succeeds.
const BUSES = [
  { id: 'stub-t504', bus_no: 'STUB504', route: 'T5040', dir: '02', lat: 2.9328562, lng: 101.6427841 },
  { id: 'stub-t505', bus_no: 'STUB505', route: 'T5050', dir: '00', lat: 2.9248442, lng: 101.6556265 },
];

const klNow = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

function payload() {
  const gps = klNow();
  const data = {};
  for (const b of BUSES) {
    data[b.id] = {
      bus_no: b.bus_no,
      route: b.route,
      dir: b.dir,
      latitude: b.lat,
      longitude: b.lng,
      speed: 12,
      trip_rev_kind: '00', // on_trip
      dt_gps: gps,
    };
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify(data))).toString('base64');
}

class StubWebSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = 0;
    this.closed = false;
    this.timer = setTimeout(() => this.#emit('0'), 0);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  #emit(data) {
    if (this.closed) return;
    for (const fn of this.listeners.get('message') ?? []) fn({ data });
  }

  send(raw) {
    this.sent++;
    const msg = String(raw);
    // Engine.IO OPEN answered: open the socket.io namespace so live.mjs subscribes.
    if (msg === '40') {
      this.timer = setTimeout(() => this.#emit('40{"sid":"stub-session"}'), 0);
      return;
    }
    // The socket.io namespace opened: live.mjs subscribes to each route with
    // "42<ack>[...]". One payload is enough for every subscription.
    if (msg.startsWith('42') && msg.includes('onFts-reload')) {
      this.timer = setTimeout(() => this.#emit(`42["onFts-client","${payload()}"]`), 10);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

globalThis.WebSocket = StubWebSocket;
