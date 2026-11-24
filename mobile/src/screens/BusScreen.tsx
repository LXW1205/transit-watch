import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fetchRoute, fetchRouteLive, fetchRoutes } from '../api';
import { useLive, useResource } from '../hooks';
import { useTheme } from '../theme';
import { Card, Empty, Loading, Notice, Screen, Segmented } from '../ui';
import type { LiveStop } from '../types';
import { LiveStatus } from './bus/LiveStatus';
import { RouteChips } from './bus/RouteChips';
import { RouteMap } from './bus/RouteMap';
import { StopList, type StopRow } from './bus/StopList';

const LIVE_POLL_MS = 15_000;

/** Bus tab: route selector, the direction's map, and live arrivals per stop. */
export function BusScreen() {
  const routes = useResource((signal) => fetchRoutes(signal), []);
  const [selected, setSelected] = useState<string | null>(null);

  const data = routes.state.data;

  // Preselect the server's `default` list (T504/T505 unless the server says
  // otherwise), skipping any name it does not actually publish.
  useEffect(() => {
    if (selected !== null || !data) return;
    const preferred =
      data.default.find((name) => data.routes.some((route) => route.name === name)) ??
      data.routes[0]?.name ??
      null;
    setSelected(preferred);
  }, [data, selected]);

  if (routes.state.status === 'error' && !data) {
    return (
      <Screen>
        <View style={styles.notice}>
          <Notice
            title="Can’t load routes"
            detail={routes.state.error.detail}
            actionLabel="Retry"
            onAction={routes.reload}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      {data && data.routes.length > 0 ? (
        <View style={styles.chips}>
          <RouteChips routes={data.routes} selected={selected} onSelect={setSelected} />
        </View>
      ) : null}

      {routes.state.status === 'loading' && !data ? <Loading label="Loading routes…" /> : null}

      {data && data.routes.length === 0 ? (
        <Empty>The server has no routes configured.</Empty>
      ) : null}

      {selected ? <RoutePanel key={selected} name={selected} /> : null}
    </Screen>
  );
}

/** One route's map and live arrivals. Remounted per route so no stale data lingers. */
function RoutePanel({ name }: { name: string }) {
  const theme = useTheme();
  const detail = useResource((signal) => fetchRoute(name, signal), [name]);
  const live = useLive((signal) => fetchRouteLive(name, signal), [name], LIVE_POLL_MS);
  const [directionId, setDirectionId] = useState<number | null>(null);

  const directions = detail.state.data?.directions ?? [];
  const direction = directions.find((item) => item.id === directionId) ?? directions[0] ?? null;

  const liveStops = useMemo(() => {
    if (!live.data || !direction) return [];
    return live.data.directions.find((item) => item.id === direction.id)?.stops ?? [];
  }, [live.data, direction]);

  // Static stop order is canonical; live data only contributes the ETA column.
  const stopRows = useMemo<StopRow[]>(() => {
    if (!direction) return [];
    const bySeq = new Map<number, LiveStop>();
    for (const stop of liveStops) bySeq.set(stop.seq, stop);
    return direction.stops.map((stop) => ({
      seq: stop.seq,
      stopId: stop.stopId,
      name: stop.name,
      lat: stop.lat,
      lng: stop.lng,
      etaMin: bySeq.get(stop.seq)?.etaMin ?? null,
    }));
  }, [direction, liveStops]);

  if (!direction) {
    if (detail.state.status === 'error') {
      return (
        <View style={styles.notice}>
          <Notice
            title={`Can’t load ${name}`}
            detail={detail.state.error.detail}
            actionLabel="Retry"
            onAction={detail.reload}
          />
        </View>
      );
    }
    if (detail.state.status === 'loading') {
      return <Loading label={`Loading ${name}…`} />;
    }
    return <Empty>This route publishes no directions.</Empty>;
  }

  const headsign = direction.headsign || `Direction ${direction.id}`;
  const vehicles = live.data?.vehicles ?? [];
  const waiting = live.data === null && !live.failed;
  const liveError = live.data === null ? live.error : null;
  const hasGeometry = direction.shape.length >= 2 || direction.stops.length > 0;

  return (
    <View style={styles.panel}>
      <LiveStatus name={name} data={live.data} failed={live.failed} />

      {directions.length > 1 ? (
        <View style={styles.direction}>
          <Segmented
            options={directions.map((item) => ({ value: item.id, label: `Dir ${item.id}` }))}
            value={direction.id}
            onChange={setDirectionId}
          />
          <Text style={[styles.headsign, { color: theme.muted }]} numberOfLines={1}>
            {headsign}
          </Text>
        </View>
      ) : (
        <Text style={[styles.headsign, { color: theme.muted }]} numberOfLines={1}>
          {headsign}
        </Text>
      )}

      <Card style={styles.mapCard}>
        {hasGeometry ? (
          <RouteMap
            shape={direction.shape}
            stops={stopRows}
            vehicles={vehicles}
            directionId={direction.id}
            fitKey={`${name}:${direction.id}`}
          />
        ) : (
          <View style={styles.center}>
            <Empty>No shape or stops are published for this direction.</Empty>
          </View>
        )}
      </Card>

      <StopList rows={stopRows} waiting={waiting} error={liveError} onRetry={live.retry} />
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { paddingTop: 10 },
  panel: { flex: 1, paddingHorizontal: 14, paddingBottom: 12, gap: 10 },
  direction: { gap: 6 },
  headsign: { fontSize: 12, paddingHorizontal: 2 },
  mapCard: { flex: 1, padding: 0, overflow: 'hidden' },
  center: { flex: 1, justifyContent: 'center' },
  notice: { padding: 14 },
});
