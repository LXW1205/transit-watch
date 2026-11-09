import { useEffect, useState } from 'react';
import { fetchRoutes } from '../api';
import { useResource } from '../hooks';
import { EmptyNotice, ErrorNotice, Loading } from './Notice';
import { RouteView } from './RouteView';

/** Bus tab: route selector plus one route's map, live ETAs and timetable. */
export function BusTab() {
  const routes = useResource(signal => fetchRoutes(signal), []);
  const [selected, setSelected] = useState<string | null>(null);

  const data = routes.state.data;

  // Preselect the server's `default` route list (T504/T505 by default).
  useEffect(() => {
    if (selected !== null || !data) return;
    const preferred =
      data.default.find(name => data.routes.some(route => route.name === name)) ??
      data.routes[0]?.name ??
      null;
    setSelected(preferred);
  }, [data, selected]);

  const summary = data?.routes.find(route => route.name === selected) ?? null;

  return (
    <section className="tab-panel">
      <div className="toolbar">
        <label className="field">
          <span>Route</span>
          <select
            value={selected ?? ''}
            onChange={event => setSelected(event.target.value || null)}
            disabled={!data || data.routes.length === 0}
          >
            {!data ? (
              <option value="">
                {routes.state.status === 'error' ? 'Routes unavailable' : 'Loading routes…'}
              </option>
            ) : null}
            {data?.routes.map(route => (
              <option key={route.name} value={route.name}>
                {route.name}
              </option>
            ))}
          </select>
        </label>
        {summary ? (
          <p className="toolbar-meta muted small">
            {summary.headsigns[0] ?? '—'} · {summary.stopCount} stops · {summary.tripCount} trips
          </p>
        ) : null}
      </div>

      {routes.state.status === 'error' ? (
        <ErrorNotice error={routes.state.error} onRetry={routes.reload} />
      ) : null}

      {routes.state.status === 'loading' && !data ? <Loading label="Loading routes…" /> : null}

      {data && data.routes.length === 0 ? (
        <EmptyNotice>The server has no routes configured.</EmptyNotice>
      ) : null}

      {selected ? <RouteView key={selected} name={selected} /> : null}
    </section>
  );
}
