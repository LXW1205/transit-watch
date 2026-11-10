import { useMemo, useState } from 'react';
import { fetchRoute } from '../api';
import { formatClock, formatMinute } from '../format';
import { useResource, useRouteLive } from '../hooks';
import type { LiveState } from '../hooks';
import { EmptyNotice, ErrorNotice, Loading, WarnNotice } from './Notice';
import { RouteMap } from './RouteMap';
import { Timetable } from './Timetable';
import type { LiveStop } from '../types';

type View = 'live' | 'timetable';

interface StopRow {
  seq: number;
  stopId: string;
  name: string;
  lat: number;
  lng: number;
  etaMin: number | null;
  nextAt: string | null;
}

function LiveStatus({ live, vehicleCount }: { live: LiveState; vehicleCount: number }) {
  if (live.status === 'loading' && live.last === null) {
    return (
      <p className="live-line">
        <span className="live-dot live-dot--idle" /> Waiting for the first live update…
      </p>
    );
  }

  if (live.status === 'error' && live.last === null) {
    return (
      <p className="live-line">
        <span className="live-dot live-dot--stale" /> Live feed unavailable
      </p>
    );
  }

  if (live.status === 'error' && live.last) {
    // Transient poll failure with data still on screen: say so quietly and keep
    // the numbers. A red "request failed" box next to "4 live vehicles" reads as
    // broken when the app is in fact retrying every few seconds.
    return (
      <p className="live-line">
        <span className="live-dot live-dot--stale" />
        Can’t reach the server — retrying
        <span className="muted small">
          · last update {formatClock(live.last.updatedAt)} · {vehicleCount} live vehicle
          {vehicleCount === 1 ? '' : 's'}
        </span>
      </p>
    );
  }

  const data = live.status === 'ready' ? live.data : live.status === 'error' ? live.last : null;
  if (!data) return null;

  return (
    <p className="live-line">
      <span className={data.stale ? 'live-dot live-dot--stale' : 'live-dot'} />
      Updated {formatClock(data.updatedAt)}
      <span className="muted small">
        · {vehicleCount} live vehicle{vehicleCount === 1 ? '' : 's'}
      </span>
      {data.stale ? <span className="badge badge--warn">stale</span> : null}
    </p>
  );
}

/** One route: map, live ETA panel and the scheduled timetable. */
export function RouteView({ name }: { name: string }) {
  const detail = useResource(signal => fetchRoute(name, signal), [name]);
  const live = useRouteLive(name);
  const [view, setView] = useState<View>('live');
  const [directionId, setDirectionId] = useState<number | null>(null);

  const directions = detail.state.data?.directions ?? [];
  const direction = directions.find(d => d.id === directionId) ?? directions[0] ?? null;
  const liveData = live.state.status === 'ready' ? live.state.data : live.state.last;

  const liveStops = useMemo(() => {
    if (!liveData || !direction) return null;
    return liveData.directions.find(d => d.id === direction.id)?.stops ?? null;
  }, [liveData, direction]);

  // Static stop order is canonical; live data only contributes the ETA columns.
  const stopRows = useMemo<StopRow[]>(() => {
    if (!direction) return [];
    const bySeq = new Map<number, LiveStop>();
    for (const stop of liveStops ?? []) bySeq.set(stop.seq, stop);
    return direction.stops.map(stop => {
      const liveStop = bySeq.get(stop.seq);
      return {
        seq: stop.seq,
        stopId: stop.stopId,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        etaMin: liveStop?.etaMin ?? null,
        nextAt: liveStop?.nextAt ?? null,
      };
    });
  }, [direction, liveStops]);

  const vehicles = useMemo(() => liveData?.vehicles ?? [], [liveData]);

  if (detail.state.status === 'error') {
    return <ErrorNotice error={detail.state.error} onRetry={detail.reload} />;
  }

  if (!direction) {
    return detail.state.status === 'loading' ? (
      <Loading label={`Loading ${name}…`} />
    ) : (
      <EmptyNotice>This route publishes no directions.</EmptyNotice>
    );
  }

  return (
    <div className="route-view">
      <div className="route-view-head">
        <div className="route-title">
          <h2>{name}</h2>
          <span className="muted small">
            {detail.state.data?.routeId} · {direction.stops.length} stops ·{' '}
            {direction.trips.length} trips
          </span>
        </div>
        <div className="segmented" role="tablist" aria-label="Bus view">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'live'}
            onClick={() => setView('live')}
          >
            Live
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'timetable'}
            onClick={() => setView('timetable')}
          >
            Timetable
          </button>
        </div>
      </div>

      <div className="direction-bar">
        {directions.length > 1 ? (
          <div className="segmented" role="group" aria-label="Direction">
            {directions.map(item => (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === direction.id}
                onClick={() => setDirectionId(item.id)}
              >
                <span className="segmented-main">{item.headsign || `Direction ${item.id}`}</span>
                <span className="segmented-sub">
                  dir {item.id} · {item.stops.length} stops
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="direction-label muted small">
            {direction.headsign || `Direction ${direction.id}`} · dir {direction.id}
          </p>
        )}
      </div>

      {view === 'timetable' ? (
        <Timetable direction={direction} />
      ) : (
        <div className="bus-layout">
          <RouteMap
            shape={direction.shape}
            stops={stopRows}
            vehicles={vehicles}
            directionId={direction.id}
            fitKey={`${name}:${direction.id}`}
          />

          <aside className="side-panel" aria-busy={live.state.status === 'loading'}>
            <div className="panel-head">
              <h3>Stops &amp; arrivals</h3>
              <LiveStatus live={live.state} vehicleCount={vehicles.length} />
            </div>

            {live.state.status === 'error' ? (
              <div className="panel-notice">
                {live.state.last ? (
                  <p className="panel-note">
                    Showing the last successful update from{' '}
                    {formatClock(live.state.last.updatedAt)}.
                    <button type="button" className="link-button" onClick={live.retry}>
                      Retry now
                    </button>
                  </p>
                ) : (
                  <ErrorNotice compact error={live.state.error} onRetry={live.retry} />
                )}
              </div>
            ) : null}

            {live.state.status === 'ready' && live.state.data.stale ? (
              <div className="panel-notice">
                <WarnNotice>Live feed is stale — ETAs may be missing until it recovers.</WarnNotice>
              </div>
            ) : null}

            {stopRows.length === 0 ? (
              <div className="panel-notice">
                <EmptyNotice>No stops are published for this direction.</EmptyNotice>
              </div>
            ) : (
              <ul className="stop-list">
                {stopRows.map(stop => (
                  <li
                    key={`${stop.seq}-${stop.stopId}`}
                    className={stop.etaMin !== null ? 'stop-row stop-row--live' : 'stop-row'}
                  >
                    <span className="stop-seq num">{stop.seq}</span>
                    <span className={stop.etaMin !== null ? 'stop-eta num stop-eta--live' : 'stop-eta num'}>
                      {stop.etaMin !== null ? (
                        <>
                          {stop.etaMin}
                          <span className="stop-eta-unit">min</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                    <span className="stop-name">
                      <span>{stop.name}</span>
                      {stop.nextAt ? (
                        <span className="stop-next">due {formatMinute(stop.nextAt)}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
