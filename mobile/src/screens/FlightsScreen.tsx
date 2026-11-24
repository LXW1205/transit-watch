import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchFlights } from '../api';
import type { ApiError, FlightQuery } from '../api';
import { formatClock, formatDate, formatPrice } from '../format';
import { useResource } from '../hooks';
import { NUMERIC, useTheme } from '../theme';
import type { Theme } from '../theme';
import type { Flight, FlightPriceChange, FlightResult } from '../types';
import {
  Badge,
  Card,
  Empty,
  Loading,
  Notice,
  Screen,
  ScrollView,
  SectionTitle,
  Segmented,
} from '../ui';
import { FareRow } from './flights/FareRow';
import { SweepRow } from './flights/SweepRow';

interface FormState {
  from: string;
  to: string;
  out: string;
  ret: string;
  oneWay: boolean;
  sweep: number;
}

const DEFAULTS: FormState = {
  from: 'KBR',
  to: 'KUL',
  out: '2026-12-18',
  ret: '2026-12-25',
  oneWay: false,
  sweep: 0,
};

const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type TripMode = 'round' | 'oneway';

const TRIP_OPTIONS: { value: TripMode; label: string }[] = [
  { value: 'round', label: 'Round trip' },
  { value: 'oneway', label: 'One-way' },
];

const SWEEP_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '0' },
  { value: 1, label: '+1' },
  { value: 2, label: '+2' },
  { value: 3, label: '+3' },
];

/** `YYYY-MM-DD` per the contract, and a day that actually exists. */
function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function toQuery(form: FormState): FlightQuery {
  return {
    from: form.from,
    to: form.to,
    out: form.out,
    ret: form.oneWay ? '' : form.ret,
    sweep: form.sweep,
  };
}

const byPrice = (flights: Flight[]): Flight[] => [...flights].sort((a, b) => a.price - b.price);

function changeLabel(change: FlightPriceChange): string {
  if (change.delta === 0) return `Price unchanged since ${formatDate(change.previous_fetched_at)}`;
  const arrow = change.delta < 0 ? '↓' : '↑';
  return `${arrow} ${formatPrice(Math.abs(change.delta))} since ${formatDate(
    change.previous_fetched_at,
  )}`;
}

function changeTone(delta: number, theme: Theme): string {
  if (delta < 0) return theme.ok;
  return delta > 0 ? theme.warn : theme.muted;
}

function errorCopy(error: ApiError): { title: string; detail: string } {
  if (error.reason === 'network') {
    return { title: 'Cannot reach the fare service', detail: error.detail };
  }
  if (error.reason === 'http_502') {
    return { title: 'The fare scrape failed', detail: error.detail };
  }
  return { title: 'Fares could not be fetched', detail: error.detail };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <SectionTitle>{label}</SectionTitle>
        {hint ? <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/** Flights tab: fare search form, cheapest-per-date sweep and the fare list. */
export function FlightsScreen() {
  const theme = useTheme();
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [applied, setApplied] = useState<FormState>(DEFAULTS);
  const [formError, setFormError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const { state, reload } = useResource(
    (signal) => fetchFlights(toQuery(applied), signal),
    [applied.from, applied.to, applied.out, applied.ret, applied.oneWay, applied.sweep],
  );

  const data = state.data;
  const results = data?.results ?? [];
  // A picked date wins until a new search drops it from the sweep; then the
  // server's cheapest date is the way in.
  const current: FlightResult | null =
    results.find((result) => result.outbound === picked) ??
    results.find((result) => result.outbound === data?.cheapestDate) ??
    results[0] ??
    null;

  const fares = current ? byPrice(current.flights) : [];
  const cheapestPrice = fares.length > 0 ? fares[0].price : Number.POSITIVE_INFINITY;
  const busy = state.status === 'loading';
  const failure = state.status === 'error' ? errorCopy(state.error) : null;

  const update = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = useCallback(() => {
    const from = form.from.trim().toUpperCase();
    const to = form.to.trim().toUpperCase();

    if (!IATA.test(from)) {
      setFormError('From must be a three-letter IATA code, e.g. KBR.');
      return;
    }
    if (!IATA.test(to)) {
      setFormError('To must be a three-letter IATA code, e.g. KUL.');
      return;
    }
    if (!isDate(form.out)) {
      setFormError('Out must be a date written as YYYY-MM-DD.');
      return;
    }
    if (!form.oneWay && !isDate(form.ret)) {
      setFormError('Return must be a date written as YYYY-MM-DD, or switch to one-way.');
      return;
    }

    setFormError(null);
    setPicked(null);
    setApplied({ ...form, from, to });
    reload();
  }, [form, reload]);

  const inputTheme = {
    color: theme.text,
    backgroundColor: theme.surfaceAlt,
    borderColor: theme.border,
  };

  return (
    <Screen>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.content}
      >
        <Card style={styles.formCard}>
          <View style={styles.row}>
            <Field label="From">
              <TextInput
                value={form.from}
                onChangeText={(from) => update({ from: from.toUpperCase() })}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                maxLength={3}
                placeholder="KBR"
                placeholderTextColor={theme.muted}
                selectionColor={theme.accent}
                accessibilityLabel="From airport IATA code"
                style={[styles.input, inputTheme]}
              />
            </Field>
            <Field label="To">
              <TextInput
                value={form.to}
                onChangeText={(to) => update({ to: to.toUpperCase() })}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                maxLength={3}
                placeholder="KUL"
                placeholderTextColor={theme.muted}
                selectionColor={theme.accent}
                accessibilityLabel="To airport IATA code"
                style={[styles.input, inputTheme]}
              />
            </Field>
          </View>

          <View style={styles.row}>
            <Field label="Out">
              <TextInput
                value={form.out}
                onChangeText={(out) => update({ out })}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                maxLength={10}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.muted}
                selectionColor={theme.accent}
                returnKeyType="search"
                onSubmitEditing={submit}
                accessibilityLabel="Outbound date, YYYY-MM-DD"
                style={[styles.input, inputTheme]}
              />
            </Field>
            <Field label="Return" hint={form.oneWay ? 'disabled' : undefined}>
              <TextInput
                value={form.ret}
                onChangeText={(ret) => update({ ret })}
                editable={!form.oneWay}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                maxLength={10}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.muted}
                selectionColor={theme.accent}
                returnKeyType="search"
                onSubmitEditing={submit}
                accessibilityLabel="Return date, YYYY-MM-DD"
                accessibilityState={{ disabled: form.oneWay }}
                style={[styles.input, inputTheme, form.oneWay ? styles.inputDisabled : null]}
              />
            </Field>
          </View>

          <Segmented
            options={TRIP_OPTIONS}
            value={form.oneWay ? 'oneway' : 'round'}
            onChange={(mode) => update({ oneWay: mode === 'oneway' })}
          />

          <View style={styles.sweepBlock}>
            <View style={styles.sweepHead}>
              <SectionTitle>Sweep</SectionTitle>
              <Text style={[styles.sweepHint, { color: theme.muted }]}>extra departure days</Text>
            </View>
            <Segmented
              options={SWEEP_OPTIONS}
              value={form.sweep}
              onChange={(sweep) => update({ sweep })}
            />
          </View>

          {formError ? <Notice tone="warn" title={formError} /> : null}

          <Pressable
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel="Search fares"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.accent, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={[styles.buttonLabel, { color: theme.accentContrast }]}>Search</Text>
          </Pressable>
        </Card>

        {failure ? (
          <Notice
            title={failure.title}
            detail={failure.detail}
            actionLabel="Retry"
            onAction={reload}
          />
        ) : null}

        {busy ? <Loading label={data ? 'Refreshing fares…' : 'Searching fares…'} /> : null}

        {data ? (
          <>
            <Card style={styles.summaryCard}>
              <Text style={[styles.summary, { color: theme.text }]}>{data.summary}</Text>
              <View style={styles.metaRow}>
                <Text style={[styles.meta, { color: theme.muted }, NUMERIC]}>
                  {data.route} · {data.trip === 'one_way' ? 'one-way' : 'round trip'} · scanned{' '}
                  {data.sweptDays} day{data.sweptDays === 1 ? '' : 's'} · fetched{' '}
                  {formatClock(data.fetchedAt)}
                </Text>
                {data.cached ? <Badge label="cached" /> : null}
                {data.stale ? <Badge label="stale" tone="warn" /> : null}
              </View>
            </Card>

            {data.sweptDays > 1 && results.length > 0 ? (
              <Card style={styles.sweepCard}>
                <View style={[styles.sweepHeader, { backgroundColor: theme.surfaceAlt }]}>
                  <SectionTitle>Cheapest per departure date</SectionTitle>
                </View>
                {results.map((result, index) => (
                  <SweepRow
                    key={result.outbound}
                    result={result}
                    selected={current?.outbound === result.outbound}
                    best={result.outbound === data.cheapestDate}
                    divider={index > 0}
                    onPress={() => setPicked(result.outbound)}
                  />
                ))}
              </Card>
            ) : null}

            {results.length === 0 ? (
              <Empty>No fares came back for these dates. Try a later date or a wider sweep.</Empty>
            ) : null}

            {current ? (
              <View style={styles.list}>
                <View style={styles.listHead}>
                  <Text style={[styles.listTitle, { color: theme.text }]}>
                    {formatDate(current.outbound)}
                    {current.ret ? ` → ${formatDate(current.ret)}` : ''}
                  </Text>
                  {current.change ? (
                    <Text
                      style={[styles.change, { color: changeTone(current.change.delta, theme) }]}
                    >
                      {changeLabel(current.change)}
                    </Text>
                  ) : null}
                </View>

                {fares.length === 0 ? (
                  <Empty>No fares were parsed for this date. Pick another departure date.</Empty>
                ) : (
                  fares.map((flight, index) => (
                    <FareRow
                      key={`${flight.airline}-${flight.depTime}-${flight.price}-${index}`}
                      flight={flight}
                      url={current.url}
                      cheapest={flight.price === cheapestPrice}
                    />
                  ))
                )}
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 14, paddingBottom: 28, gap: 12 },
  formCard: { gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
  field: { flex: 1, gap: 4 },
  fieldHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  hint: { fontSize: 10 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    fontWeight: '600',
  },
  inputDisabled: { opacity: 0.5 },
  sweepBlock: { gap: 5 },
  sweepHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  sweepHint: { fontSize: 10.5 },
  button: { borderRadius: 9, paddingVertical: 11, alignItems: 'center' },
  buttonLabel: { fontSize: 14, fontWeight: '700' },
  summaryCard: { gap: 6 },
  summary: { fontSize: 14.5, lineHeight: 20 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  meta: { fontSize: 11.5 },
  sweepCard: { padding: 0, overflow: 'hidden' },
  sweepHeader: { paddingHorizontal: 12, paddingVertical: 7 },
  list: { gap: 8 },
  listHead: { gap: 2 },
  listTitle: { fontSize: 15, fontWeight: '700' },
  change: { fontSize: 12 },
});
