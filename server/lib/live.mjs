// Live vehicle positions for MyRapid routes.
//
// The kiosk page migrated its backend (observed 2026-11-24): the old
// socket.io host `rapidbus-socketio-avl.prasarana.com.my` is gone (TCP
// unreachable), and `/kiosk` now reads
//
//   GET https://myrapidbus.prasarana.com.my/avl/api/avl/route/<code>
//   wss://myrapidbus.prasarana.com.my/avl/app/<key>   (Pusher, channel avl.route.<code>)
//
// The REST route is what we use: plain JSON, no handshake, no gzip, and it is
// reachable without browser headers. It is strictly better than the old feed —
// it carries `angle` (GPS heading), `busstop_id` and `is_inside_endstop`, and
// `source: "traccar"` tells us the upstream.
//
// Route codes carry a variant digit: T504 is served as `T5040`. We try the
// suffixed code first and fall back to the bare name.

export const PROVIDER = 'RKL';
export const AVL_API = 'https://myrapidbus.prasarana.com.my/avl/api/avl/route';

// trip_rev_kind legend, from the kiosk page's icon mapping
const STATUS = {
  '00': 'on_trip',
  '99': 'off_trip',
  '01': 'contingency',
  '03': 'contingency',
  '05': 'contingency',
};

// A route name matches `<name>` or `<name><digit>` (T504 → T5040), without
// letting T50 swallow T504.
export const routeMatches = (actual, name) =>
  new RegExp(`^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d?$`).test(String(actual ?? ''));

// The kiosk page treats GPS older than 5 minutes as stale; we mirror that.
export const LIVE_AGE_S = 300;

const codeCandidates = (name) => [...new Set([`${name}0`, String(name)])];

async function fetchRouteVehicles(name, { timeoutMs, log }) {
  let lastError = null;

  for (const code of codeCandidates(name)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${AVL_API}/${encodeURIComponent(code)}`, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${code}`), { reason: `http_${res.status}` });
      const body = await res.json();
      const vehicles = Array.isArray(body?.vehicles) ? body.vehicles : [];
      // An empty list may mean "wrong code variant" — only then try the next one.
      if (vehicles.length === 0 && code !== codeCandidates(name).at(-1)) {
        log(`live: ${code} returned no vehicles, trying the next code variant`);
        continue;
      }
      return vehicles;
    } catch (e) {
      lastError = e.name === 'AbortError'
        ? Object.assign(new Error(`no response in ${timeoutMs}ms for ${code}`), { reason: 'timeout' })
        : Object.assign(e, { reason: e.reason ?? 'network' });
      log(`live: ${code} failed — ${lastError.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? Object.assign(new Error(`no route code matched ${name}`), { reason: 'no_code' });
}

function toBus(v, now) {
  const gpsMs = Date.parse(String(v.dt_gps ?? '').replace(' ', 'T') + '+08:00');
  const ageS = Number.isNaN(gpsMs) ? null : Math.max(0, Math.round((now - gpsMs) / 1000));
  const angle = Number(v.angle);
  return {
    bus_no: v.bus_no,
    route: v.route,
    direction: v.dir,
    lat: Number(v.latitude),
    lng: Number(v.longitude),
    speed_kmh: Number(v.speed) || 0,
    status: STATUS[v.trip_rev_kind] ?? `unknown(${v.trip_rev_kind})`,
    gps_time: v.dt_gps,
    gps_age_s: ageS,
    live: ageS !== null && ageS <= LIVE_AGE_S,
    // extras the old feed did not carry
    angle: Number.isFinite(angle) ? angle : null,
    busstop_id: v.busstop_id ?? null,
    at_stop: v.is_inside_endstop ?? null,
    source: v.source ?? null,
  };
}

/**
 * Collect live positions for the given route names.
 *
 * @returns {Promise<{ok: boolean, fetchedAt: string, routes: Record<string,{buses: object[]}>, error?: {reason: string, detail: string}}>}
 *   An empty route is a successful answer; only a transport failure sets ok:false.
 */
export async function collectPositions(routes, { timeoutMs = 10_000, log = () => {} } = {}) {
  const fetchedAt = new Date().toISOString();
  const now = Date.now();
  const names = [...new Set(routes)];
  const out = Object.fromEntries(names.map((n) => [n, { buses: [] }]));
  const failures = [];

  const settled = await Promise.allSettled(
    names.map(async (name) => [name, await fetchRouteVehicles(name, { timeoutMs, log })]),
  );

  for (const [i, result] of settled.entries()) {
    const name = names[i];
    if (result.status === 'rejected') {
      failures.push({ name, error: result.reason });
      continue;
    }
    const [, vehicles] = result.value;
    out[name].buses = vehicles
      .filter((v) => v && v.bus_no && routeMatches(v.route, name))
      .map((v) => toBus(v, now));
    log(`live: ${name} → ${out[name].buses.length} vehicle(s)`);
  }

  if (failures.length === names.length) {
    const first = failures[0].error;
    return {
      ok: false,
      fetchedAt,
      routes: out,
      error: { reason: first?.reason ?? 'network', detail: first?.message ?? String(first) },
    };
  }

  return { ok: true, fetchedAt, routes: out };
}
