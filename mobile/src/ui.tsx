import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { NUMERIC, useTheme } from './theme';

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return <View style={[{ flex: 1, backgroundColor: theme.bg }, style]}>{children}</View>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.surface,
          borderColor: theme.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 12,
          padding: 14,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      style={{
        color: theme.muted,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </Text>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' }) {
  const theme = useTheme();
  const bg = {
    neutral: theme.surfaceAlt,
    ok: theme.accentSoft,
    warn: theme.warnSoft,
    danger: theme.dangerSoft,
    accent: theme.accentSoft,
  }[tone];
  const fg = {
    neutral: theme.muted,
    ok: theme.ok,
    warn: theme.warn,
    danger: theme.danger,
    accent: theme.accent,
  }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text style={{ color: fg, fontSize: 10, fontWeight: '700', letterSpacing: 0.4 }}>{label}</Text>
    </View>
  );
}

export function Loading({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 }}>
      <ActivityIndicator size="small" color={theme.accent} />
      <Text style={{ color: theme.muted, fontSize: 13 }}>{label}</Text>
    </View>
  );
}

export function Notice({
  title,
  detail,
  tone = 'danger',
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: string;
  tone?: 'danger' | 'warn' | 'info';
  actionLabel?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  const bg = tone === 'danger' ? theme.dangerSoft : tone === 'warn' ? theme.warnSoft : theme.accentSoft;
  const fg = tone === 'danger' ? theme.danger : tone === 'warn' ? theme.warn : theme.accent;

  return (
    <View style={{ backgroundColor: bg, borderRadius: 10, padding: 12, gap: 4 }}>
      <Text style={{ color: fg, fontWeight: '700', fontSize: 13 }}>{title}</Text>
      {detail ? <Text style={{ color: theme.text, fontSize: 12, lineHeight: 17 }}>{detail}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          <Text style={{ color: fg, fontWeight: '700', fontSize: 12, textDecorationLine: 'underline' }}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ padding: 16, alignItems: 'center' }}>
      <Text style={{ color: theme.muted, fontSize: 13, textAlign: 'center' }}>{children}</Text>
    </View>
  );
}

/** A horizontal strip of mutually exclusive options (used for tabs/segments). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: theme.surfaceAlt,
        borderRadius: 9,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              paddingVertical: 7,
              borderRadius: 7,
              backgroundColor: selected ? theme.surface : 'transparent',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: selected ? theme.text : theme.muted,
                fontWeight: selected ? '700' : '500',
                fontSize: 12.5,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function KeyValueRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: theme.muted, fontSize: 12 }}>{label}</Text>
      <Text style={[{ color: theme.text, fontSize: 12, fontWeight: '600' }, NUMERIC]}>{value}</Text>
    </View>
  );
}

export { ScrollView };
