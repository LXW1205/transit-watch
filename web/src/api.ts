import type {
  ApiErrorBody,
  FlightsResponse,
  LiveResponse,
  RouteDetail,
  RoutesResponse,
} from './types';

/** A failed API call, normalised from HTTP errors, network failures and bad JSON. */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly detail: string;

  constructor(status: number, reason: string, detail: string) {
    super(detail || reason);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) return new ApiError(0, 'unknown', err.message);
  return new ApiError(0, 'unknown', String(err));
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError(
      0,
      'network',
      'Could not reach the transit server. Check that the API is running and try again.',
    );
  }

  const text = await res.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(
        res.status,
        'parse_failed',
        `The server sent a non-JSON response (HTTP ${res.status}).`,
      );
    }
  }

  if (!res.ok) {
    const envelope = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      envelope?.reason ?? `http_${res.status}`,
      envelope?.detail ?? `Request failed with HTTP ${res.status}.`,
    );
  }

  if (body === null) {
    throw new ApiError(res.status, 'parse_failed', 'The server sent an empty response.');
  }

  return body as T;
}

export function fetchRoutes(signal?: AbortSignal): Promise<RoutesResponse> {
  return request<RoutesResponse>('/api/routes', signal);
}

export function fetchRoute(name: string, signal?: AbortSignal): Promise<RouteDetail> {
  return request<RouteDetail>(`/api/route/${encodeURIComponent(name)}`, signal);
}

export function fetchRouteLive(name: string, signal?: AbortSignal): Promise<LiveResponse> {
  return request<LiveResponse>(`/api/route/${encodeURIComponent(name)}/live`, signal);
}

export interface FlightQuery {
  from: string;
  to: string;
  out: string;
  /** Empty for a one-way search. */
  ret: string;
  sweep: number;
}

export async function fetchFlights(
  query: FlightQuery,
  signal?: AbortSignal,
): Promise<FlightsResponse> {
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
    out: query.out,
    sweep: String(query.sweep),
  });
  if (query.ret) params.set('ret', query.ret);

  const data = await request<FlightsResponse>(`/api/flights?${params.toString()}`, signal);
  if (data.ok !== true) {
    throw new ApiError(
      502,
      'scrape_failed',
      'The fare search could not be completed. Google Flights may be rate limiting us.',
    );
  }
  return data;
}
