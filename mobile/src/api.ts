import type {
  FlightsResponse,
  LiveResponse,
  RouteDetail,
  RoutesResponse,
} from './types';

/**
 * Where the API lives.
 *
 * On a phone `localhost` is the phone, so this must be the homelab's LAN address
 * (or its Tailscale address when you are away from home). Set
 * `EXPO_PUBLIC_API_URL` in `mobile/.env` to override.
 */
export const API_BASE = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://192.168.1.15:8787'
).replace(/\/+$/, '');

export class ApiError extends Error {
  readonly reason: string;
  readonly detail: string;

  constructor(reason: string, detail: string) {
    super(detail || reason);
    this.name = 'ApiError';
    this.reason = reason;
    this.detail = detail;
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      signal,
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError('network', `Could not reach the API at ${API_BASE}.`);
  }

  if (!response.ok) {
    let reason = `http_${response.status}`;
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: { reason?: string; detail?: string } };
      reason = body?.error?.reason ?? reason;
      detail = body?.error?.detail ?? detail;
    } catch {
      // a non-JSON error body is not worth a second failure
    }
    throw new ApiError(reason, detail || `HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export const fetchRoutes = (signal?: AbortSignal) => get<RoutesResponse>('/api/routes', signal);

export const fetchRoute = (name: string, signal?: AbortSignal) =>
  get<RouteDetail>(`/api/route/${encodeURIComponent(name)}`, signal);

export const fetchRouteLive = (name: string, signal?: AbortSignal) =>
  get<LiveResponse>(`/api/route/${encodeURIComponent(name)}/live`, signal);

export interface FlightQuery {
  from: string;
  to: string;
  out: string;
  /** Empty string for a one-way search. */
  ret: string;
  sweep: number;
}

export const fetchFlights = (query: FlightQuery, signal?: AbortSignal) => {
  const params = new URLSearchParams({
    from: query.from.toUpperCase(),
    to: query.to.toUpperCase(),
    out: query.out,
    sweep: String(query.sweep),
  });
  if (query.ret) params.set('ret', query.ret);
  return get<FlightsResponse>(`/api/flights?${params.toString()}`, signal);
};
