import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useTheme } from '../../theme';
import type { RouteSummary } from '../../types';

/** Horizontal route selector. The strip scrolls; the page never does. */
export function RouteChips({
  routes,
  selected,
  onSelect,
}: {
  routes: RouteSummary[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const theme = useTheme();

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {routes.map((route) => {
        const active = route.name === selected;
        return (
          <Pressable
            key={route.name}
            onPress={() => onSelect(route.name)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Route ${route.name}${active ? ', selected' : ''}`}
            style={({ pressed }) => [
              styles.chip,
              {
                backgroundColor: active ? theme.accent : theme.surface,
                borderColor: active ? theme.accent : theme.border,
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <Text style={[styles.label, { color: active ? theme.accentContrast : theme.text }]}>
              {route.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 14 },
  chip: {
    minHeight: 40,
    minWidth: 60,
    paddingHorizontal: 14,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },
});
