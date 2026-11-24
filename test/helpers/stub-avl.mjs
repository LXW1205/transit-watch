// Preloaded into the spawned API server (`node --import <this> server/index.mjs`)
// so /api/route/:name/live never touches the real MyRapid AVL API.
//
// live.mjs reads vehicle positions over plain `fetch` now (the socket.io feed was
// decommissioned), so this patches globalThis.fetch for the AVL route endpoint
// only and lets every other request through untouched.
//
// The buses are placed at real points on the T504/T505 shapes in the cached GTFS
// feed, so the server still computes genuine ETAs — the only fake is transport.

const STUB_BUSES = {
  T5040: [
    { bus_no: 'STUB504', route: 'T5040', dir: '02', latitude: 2.9328562, longitude: 101.6427841, speed: 12, angle: 95 },
  ],
  T5050: [
    { bus_no: 'STUB505', route: 'T5050', dir: '00', latitude: 2.9248442, longitude: 101.6556265, speed: 18, angle: 200 },
  ],
};

// Same format the real feed uses: Asia/Kuala_Lumpur, no offset.
const klNow = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

const AVL_PATH = /\/avl\/api\/avl\/route\/([A-Za-z0-9]+)\/?$/;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const match = AVL_PATH.exec(url);

  if (match) {
    const code = match[1];
    const now = klNow();
    const vehicles = (STUB_BUSES[code] ?? []).map((bus) => ({
      ...bus,
      dt_received: now,
      dt_gps: now,
      trip_no: null,
      captain_id: '',
      trip_rev_kind: '00', // on_trip
      engine_status: '1',
      accessibility: 1,
      busstop_id: null,
      is_inside_endstop: null,
      is_inside_shape: null,
      source: 'stub',
      region: 'rkl',
    }));
    return new Response(
      JSON.stringify({ route: code, count: vehicles.length, filters_applied: [], vehicles }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  return realFetch(input, init);
};
