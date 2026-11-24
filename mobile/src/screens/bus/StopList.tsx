import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ApiError } from '../../api';
import { NUMERIC, useTheme } from '../../theme';
import { Badge, Card, Empty, Loading, Notice, SectionTitle } from '../../ui';

export interface StopRow {
  seq: number;
  stopId: string;
  name: string;
  lat: number;
  lng: number;
  etaMin: number | null;
}

/**
 * Stops in travel order with the live ETA beside each one. The list scrolls on
 * its own: the map above stays put however far down the route you are looking.
 */
export function StopList({
  rows,
  waiting,
  error,
  onRetry,
}: {
  rows: StopRow[];
  /** True until the first live payload arrives; rows still render, without ETAs. */
  waiting: boolean;
  /** Set only when there is no live payload at all — a failed poll keeps the rows. */
  error: ApiError | null;
  onRetry: () => void;
}) {
  const theme = useTheme();
  const live = rows.filter((row) => row.etaMin !== null).length;

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <SectionTitle>Stops &amp; arrivals</SectionTitle>
        <Text style={[styles.count, { color: theme.muted }, NUMERIC]}>
          {live > 0 ? `${live} with ETA` : `${rows.length} stops`}
        </Text>
      </View>
      <View style={[styles.rule, { backgroundColor: theme.border }]} />

      {waiting ? <Loading label="Waiting for live arrivals…" /> : null}

      {error ? (
        <View style={styles.notice}>
          <Notice
            title="Live arrivals unavailable"
            detail={error.detail}
            actionLabel="Retry"
            onAction={onRetry}
          />
        </View>
      ) : null}

      {rows.length === 0 ? (
        <Empty>No stops are published for this direction.</Empty>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {rows.map((row) => (
            <Row key={`${row.seq}-${row.stopId}`} row={row} />
          ))}
        </ScrollView>
      )}
    </Card>
  );
}

function Row({ row }: { row: StopRow }) {
  const theme = useTheme();
  const served = row.etaMin !== null;

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: served ? theme.accentSoft : 'transparent',
          borderLeftColor: served ? theme.accent : 'transparent',
        },
      ]}
    >
      <Text style={[styles.seq, { color: theme.muted }, NUMERIC]}>{row.seq}</Text>
      <View style={styles.eta}>
        <Badge label={served ? `${row.etaMin} min` : '—'} tone={served ? 'accent' : 'neutral'} />
      </View>
      <Text style={[styles.name, { color: theme.text }]} numberOfLines={2}>
        {row.name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, padding: 0, overflow: 'hidden' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  count: { fontSize: 11 },
  rule: { height: StyleSheet.hairlineWidth },
  notice: { padding: 10 },
  scroll: { flex: 1 },
  scrollContent: { paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderLeftWidth: 3,
  },
  seq: { fontSize: 11, width: 22 },
  eta: { width: 58, alignItems: 'flex-start' },
  name: { fontSize: 13, flex: 1 },
});
