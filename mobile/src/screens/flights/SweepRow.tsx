import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDate, formatPrice } from '../../format';
import { NUMERIC, useTheme } from '../../theme';
import type { FlightResult } from '../../types';
import { Badge } from '../../ui';

/** One departure date in a sweep: its cheapest fare, tappable to list that day. */
export function SweepRow({
  result,
  selected,
  best,
  divider,
  onPress,
}: {
  result: FlightResult;
  selected: boolean;
  best: boolean;
  divider: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessible
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Fares for ${formatDate(result.outbound)}, cheapest ${formatPrice(
        result.cheapest.price,
      )} on ${result.cheapest.airline}`}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: selected ? theme.accentSoft : pressed ? theme.surfaceAlt : 'transparent',
          borderTopWidth: divider ? StyleSheet.hairlineWidth : 0,
          borderTopColor: theme.border,
          borderLeftColor: selected ? theme.accent : 'transparent',
        },
      ]}
    >
      <View style={styles.head}>
        <Text
          style={[
            styles.date,
            {
              color: selected ? theme.accent : theme.text,
              fontWeight: selected ? '700' : '600',
            },
          ]}
        >
          {formatDate(result.outbound)}
        </Text>
        <Text style={[styles.price, { color: selected ? theme.accent : theme.text }, NUMERIC]}>
          {formatPrice(result.cheapest.price)}
        </Text>
      </View>

      <View style={styles.footer}>
        <Text style={[styles.airline, { color: theme.muted }]} numberOfLines={1}>
          {result.cheapest.airline}
        </Text>
        {best ? <Badge label="cheapest" tone="accent" /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { borderLeftWidth: 2, paddingVertical: 9, paddingHorizontal: 12, gap: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  date: { flex: 1, fontSize: 13.5 },
  price: { fontSize: 15, fontWeight: '700' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  airline: { flex: 1, fontSize: 11.5 },
});
