import { StyleSheet, Text, View } from 'react-native';

import { formatClock } from '../../format';
import { NUMERIC, useTheme } from '../../theme';
import { Badge, Card } from '../../ui';
import type { LiveResponse } from '../../types';

/**
 * Header strip: which route, how fresh the live data is, and whether the last
 * poll failed. A failed poll with data on screen stays quiet — the numbers are
 * still the best thing we have and the app is already retrying.
 */
export function LiveStatus({
  name,
  data,
  failed,
}: {
  name: string;
  data: LiveResponse | null;
  failed: boolean;
}) {
  const theme = useTheme();
  const count = data?.vehicles.length ?? 0;

  const updated = data
    ? `Updated ${formatClock(data.updatedAt)}`
    : failed
      ? 'No live data yet'
      : 'Waiting for live data…';

  return (
    <Card style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
          {name}
        </Text>
        {failed ? <Badge label="offline" tone="warn" /> : null}
        {!failed && data?.stale ? <Badge label="stale" tone="warn" /> : null}
      </View>

      <View style={styles.metaRow}>
        <Text style={[styles.meta, { color: theme.muted }, NUMERIC]}>{updated}</Text>
        {data ? (
          <Text style={[styles.meta, { color: theme.muted }, NUMERIC]}>
            · {count} {count === 1 ? 'vehicle' : 'vehicles'}
          </Text>
        ) : null}
      </View>

      {failed && data ? (
        <Text style={[styles.retrying, { color: theme.warn }]}>
          Can’t reach the server — retrying
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 5 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 20, fontWeight: '800', letterSpacing: 0.2, flexShrink: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  meta: { fontSize: 12 },
  retrying: { fontSize: 12, fontWeight: '600' },
});
