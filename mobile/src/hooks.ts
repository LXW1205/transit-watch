import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from './api';

export type ResourceState<T> =
  // `loading` may still carry the previous payload: a refresh must not blank the
  // screen, so the union has to allow data while loading.
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: ApiError };

/** One-shot fetch with abort + a manual retry. */
export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): { state: ResourceState<T>; reload: () => void } {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading', data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    loaderRef.current(controller.signal)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled || (err as Error)?.name === 'AbortError') return;
        setState((prev) => ({
          status: 'error',
          data: prev.status === 'ready' ? prev.data : prev.data,
          error: err instanceof ApiError ? err : new ApiError('unexpected', String(err)),
        }));
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    setState((prev) => ({ status: 'loading', data: prev.data, error: null }));
    setNonce((n) => n + 1);
  }, []);

  return { state, reload };
}

/**
 * Live polling. Keeps the last good payload when a poll fails, and keeps
 * retrying — a phone on a flaky connection should not need a manual refresh.
 */
export function useLive<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  intervalMs = 15_000,
): { data: T | null; error: ApiError | null; failed: boolean; retry: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    const poll = async () => {
      controller = new AbortController();
      try {
        const next = await loaderRef.current(controller.signal);
        if (cancelled) return;
        setData(next);
        setError(null);
        setFailed(false);
      } catch (err) {
        if (cancelled || (err as Error)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err : new ApiError('unexpected', String(err)));
        setFailed(true);
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), intervalMs);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, intervalMs]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, failed, retry };
}
