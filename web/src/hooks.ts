import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';
import { ApiError, fetchRouteLive, toApiError } from './api';
import type { LiveResponse } from './types';

/** The UI polls `/live` at this interval. */
export const LIVE_POLL_MS = 15_000;

export type ResourceState<T> =
  | { status: 'loading'; data: T | null }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: ApiError; data: T | null };

export interface Resource<T> {
  state: ResourceState<T>;
  reload: () => void;
}

/**
 * Runs `load` whenever `deps` change, aborting the previous request.
 * A reload keeps the last successful payload visible while it re-fetches.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading', data: null });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setState(prev => ({ status: 'loading', data: prev.data }));

    loadRef.current(controller.signal).then(
      data => {
        if (active) setState({ status: 'ready', data });
      },
      (err: unknown) => {
        if (!active || (err instanceof Error && err.name === 'AbortError')) return;
        setState({ status: 'error', error: toApiError(err), data: null });
      },
    );

    return () => {
      active = false;
      controller.abort();
    };
    // `deps` is the caller's dependency list; the array is spread so React sees each entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  return { state, reload };
}

export type LiveState =
  | { status: 'loading'; last: LiveResponse | null }
  | { status: 'ready'; data: LiveResponse }
  | { status: 'error'; error: ApiError; last: LiveResponse | null };

export interface LiveResource {
  state: LiveState;
  retry: () => void;
}

/**
 * Polls `/api/route/:name/live` on a finished-then-scheduled timer, so a slow
 * response never stacks requests. Stops on unmount and on route change.
 */
export function useRouteLive(name: string): LiveResource {
  const [state, setState] = useState<LiveState>({ status: 'loading', last: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const poll = async () => {
      controller = new AbortController();
      try {
        const data = await fetchRouteLive(name, controller.signal);
        if (cancelled) return;
        setState({ status: 'ready', data });
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setState(prev => ({
          status: 'error',
          error: toApiError(err),
          last: prev.status === 'ready' ? prev.data : prev.last,
        }));
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void poll();
          }, LIVE_POLL_MS);
        }
      }
    };

    setState(prev => ({
      status: 'loading',
      last: prev.status === 'ready' ? prev.data : prev.last,
    }));
    void poll();

    return () => {
      cancelled = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [name, nonce]);

  const retry = useCallback(() => setNonce(n => n + 1), []);

  return { state, retry };
}
