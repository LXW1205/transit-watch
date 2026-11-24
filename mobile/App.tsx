import { useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BusScreen } from './src/screens/BusScreen';
import { FlightsScreen } from './src/screens/FlightsScreen';
import { useTheme } from './src/theme';

type Tab = 'bus' | 'flights';

function Shell() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('bus');

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }}>
      <StatusBar barStyle={theme.scheme === 'dark' ? 'light-content' : 'dark-content'} />

      <View style={{ flex: 1 }}>{tab === 'bus' ? <BusScreen /> : <FlightsScreen />}</View>

      <View
        style={[
          styles.tabBar,
          {
            backgroundColor: theme.surface,
            borderTopColor: theme.border,
            paddingBottom: Math.max(insets.bottom, 8),
          },
        ]}
      >
        {(
          [
            { key: 'bus', label: 'Bus', glyph: '🚌' },
            { key: 'flights', label: 'Flights', glyph: '✈️' },
          ] as const
        ).map((item) => {
          const active = tab === item.key;
          return (
            <Pressable
              key={item.key}
              onPress={() => setTab(item.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={styles.tabButton}
            >
              <Text style={{ fontSize: 20, opacity: active ? 1 : 0.45 }}>{item.glyph}</Text>
              <Text
                style={{
                  color: active ? theme.accent : theme.muted,
                  fontSize: 11,
                  fontWeight: active ? '700' : '500',
                  marginTop: 2,
                }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
