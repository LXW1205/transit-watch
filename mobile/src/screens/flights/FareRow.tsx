import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatPrice } from '../../format';
import { NUMERIC, useTheme } from '../../theme';
import type { Flight } from '../../types';
import { Badge, Card } from '../../ui';

/**
 * One fare, exactly as scraped from Google Flights. The whole row is the tap
 * target: Google has no stable per-itinerary URL, so it opens the dated search
 * the price came from (`result.url`), the same provenance link as the web app.
 */
export function FareRow({
  flight,
  url,
  cheapest,
}: {
  flight: Flight;
  url: string;
  cheapest: boolean;
}) {
  const theme = useTheme();

  const openSource = () => {
    Linking.openURL(url).catch(() => {
      // The OS had no browser to hand this to; nothing useful to say mid-list.
    });
  };

  return (
    <Pressable
      onPress={openSource}
      accessible
      accessibilityRole="link"
      accessibilityLabel={`Open the Google Flights search for ${flight.airline} ${formatPrice(
        flight.price,
      )}, departing ${flight.depTime}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}
    >
      <Card
        style={[
          styles.card,
          cheapest ? { backgroundColor: theme.accentSoft, borderColor: theme.accent } : null,
        ]}
      >
        <View style={styles.cost}>
          <Text style={[styles.price, { color: cheapest ? theme.accent : theme.text }, NUMERIC]}>
            {formatPrice(flight.price)}
          </Text>
          <View style={[styles.source, { borderColor: theme.border }]}>
            <Text style={[styles.sourceGlyph, { color: theme.muted }]}>↗</Text>
          </View>
          <View style={styles.grow} />
          {cheapest ? <Badge label="cheapest" tone="accent" /> : null}
        </View>

        <Text style={[styles.airline, { color: theme.text }]}>{flight.airline}</Text>

        <Text style={[styles.times, { color: theme.text }, NUMERIC]}>
          {flight.depTime} <Text style={{ color: theme.muted }}>→</Text> {flight.arrTime}
        </Text>

        <Text style={[styles.meta, { color: theme.muted }, NUMERIC]}>
          {flight.duration} · {flight.stops}
        </Text>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 10, paddingHorizontal: 12, gap: 4 },
  cost: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  price: { fontSize: 20, fontWeight: '700' },
  source: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  sourceGlyph: { fontSize: 11, lineHeight: 13 },
  grow: { flex: 1 },
  airline: { fontSize: 13.5, fontWeight: '600' },
  times: { fontSize: 14 },
  meta: { fontSize: 12 },
});
