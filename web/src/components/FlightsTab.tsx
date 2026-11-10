import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { fetchFlights } from '../api';
import {
  durationMinutes,
  formatDate,
  formatPrice,
  formatStamp,
  timeOfDayMinutes,
} from '../format';
import { useResource } from '../hooks';
import { EmptyNotice, ErrorNotice, Loading } from './Notice';
import type { FlightQuery } from '../api';
import type { Flight, FlightResult } from '../types';

type SortKey = 'price' | 'departure' | 'duration';

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
  out: '2026-11-18',
  ret: '2026-11-25',
  oneWay: false,
  sweep: 0,
};

const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const SWEEP_OPTIONS = [
  { value: 0, label: '0 — outbound only' },
  { value: 1, label: '1 — next day too' },
  { value: 2, label: '2 — 2 extra days' },
  { value: 3, label: '3 — 3 extra days' },
];

const SORT_LABELS: Record<SortKey, string> = {
  price: 'Price',
  departure: 'Departure',
  duration: 'Duration',
};

function toQuery(form: FormState): FlightQuery {
  return {
    from: form.from,
    to: form.to,
    out: form.out,
    ret: form.oneWay ? '' : form.ret,
    sweep: form.sweep,
  };
}

function sortFlights(flights: Flight[], key: SortKey): Flight[] {
  const list = [...flights];
  list.sort((a, b) => {
    if (key === 'price') return a.price - b.price;
    if (key === 'duration') return durationMinutes(a.duration) - durationMinutes(b.duration);
    return timeOfDayMinutes(a.depTime) - timeOfDayMinutes(b.depTime);
  });
  return list;
}

/** Flights tab: fare search form, cheapest-per-date sweep and the fare list. */
export function FlightsTab() {
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [applied, setApplied] = useState<FormState>(DEFAULTS);
  const [formError, setFormError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('price');

  const flights = useResource(
    signal => fetchFlights(toQuery(applied), signal),
    [applied.from, applied.to, applied.out, applied.ret, applied.oneWay, applied.sweep],
  );

  const data = flights.state.data;
  const results = data?.results ?? [];

  const current: FlightResult | null =
    results.find(result => result.outbound === picked) ??
    results.find(result => result.outbound === data?.cheapestDate) ??
    results[0] ??
    null;

  const rows = useMemo(() => sortFlights(current?.flights ?? [], sort), [current, sort]);
  const cheapestPrice = rows.reduce((min, flight) => Math.min(min, flight.price), Infinity);
  const maxPrice = results.reduce((max, result) => Math.max(max, result.cheapest.price), 1);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const from = form.from.trim().toUpperCase();
    const to = form.to.trim().toUpperCase();

    if (!IATA.test(from) || !IATA.test(to)) {
      setFormError('Enter three-letter IATA codes, for example KBR and KUL.');
      return;
    }
    if (!DATE.test(form.out)) {
      setFormError('Pick an outbound date.');
      return;
    }
    if (!form.oneWay && !DATE.test(form.ret)) {
      setFormError('Pick a return date, or switch to one-way.');
      return;
    }

    setFormError(null);
    setPicked(null);
    setApplied({ ...form, from, to });
    flights.reload();
  };

  return (
    <section className="tab-panel">
      <form className="flights-form" onSubmit={submit}>
        <label className="field">
          <span>From</span>
          <input
            className="input-iata"
            type="text"
            value={form.from}
            maxLength={3}
            autoComplete="off"
            spellCheck={false}
            onChange={event => setForm(prev => ({ ...prev, from: event.target.value.toUpperCase() }))}
          />
        </label>
        <label className="field">
          <span>To</span>
          <input
            className="input-iata"
            type="text"
            value={form.to}
            maxLength={3}
            autoComplete="off"
            spellCheck={false}
            onChange={event => setForm(prev => ({ ...prev, to: event.target.value.toUpperCase() }))}
          />
        </label>
        <label className="field">
          <span>Out</span>
          <input
            type="date"
            value={form.out}
            onChange={event => setForm(prev => ({ ...prev, out: event.target.value }))}
          />
        </label>
        <label className="field">
          <span>Return</span>
          <input
            type="date"
            value={form.ret}
            disabled={form.oneWay}
            onChange={event => setForm(prev => ({ ...prev, ret: event.target.value }))}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.oneWay}
            onChange={event => setForm(prev => ({ ...prev, oneWay: event.target.checked }))}
          />
          <span>One-way</span>
        </label>
        <label className="field">
          <span>Sweep</span>
          <select
            value={form.sweep}
            onChange={event => setForm(prev => ({ ...prev, sweep: Number(event.target.value) }))}
          >
            {SWEEP_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="button button--primary"
          disabled={flights.state.status === 'loading'}
        >
          Search
        </button>
      </form>

      {formError ? (
        <p className="notice notice--warn" role="alert">
          {formError}
        </p>
      ) : null}

      {flights.state.status === 'error' ? (
        <ErrorNotice error={flights.state.error} onRetry={flights.reload} />
      ) : null}

      {flights.state.status === 'loading' ? (
        <Loading label={data ? 'Refreshing fares…' : 'Searching fares…'} />
      ) : null}

      {data ? (
        <div className="results">
          <div className="results-head">
            <p className="summary">{data.summary}</p>
            <p className="meta-line">
              <span>{data.route}</span>
              <span>·</span>
              <span>{data.trip === 'one_way' ? 'one-way' : 'round trip'}</span>
              <span>·</span>
              <span>
                scanned {data.sweptDays} day{data.sweptDays === 1 ? '' : 's'}
              </span>
              <span>·</span>
              <span>fetched {formatStamp(data.fetchedAt)}</span>
              {current ? (
                <a
                  className="meta-link"
                  href={current.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open this search on Google Flights"
                >
                  source: Google Flights ↗
                </a>
              ) : null}
              {data.cached ? <span className="badge">cached</span> : null}
              {data.stale ? <span className="badge badge--warn">stale</span> : null}
            </p>
          </div>

          {results.length === 0 ? <EmptyNotice>No fares came back for these dates.</EmptyNotice> : null}

          {results.length > 1 ? (
            <div className="sweep" role="group" aria-label="Cheapest fare per departure date">
              <div className="sweep-head">
                <span>Depart</span>
                <span>Cheapest</span>
                <span>Relative price</span>
                <span>Airline</span>
              </div>
              {results.map(result => {
                const isCurrent = current?.outbound === result.outbound;
                const isCheapestDay = result.outbound === data.cheapestDate;
                return (
                  <button
                    key={result.outbound}
                    type="button"
                    className={isCheapestDay ? 'sweep-row sweep-row--best' : 'sweep-row'}
                    aria-pressed={isCurrent}
                    onClick={() => setPicked(result.outbound)}
                  >
                    <span>{formatDate(result.outbound)}</span>
                    <span className="sweep-price num">{formatPrice(result.cheapest.price)}</span>
                    <span className="sweep-bar">
                      <span
                        style={{
                          width: `${Math.round((result.cheapest.price / maxPrice) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="muted small">{result.cheapest.airline}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {current ? (
            <>
              <div className="list-head">
                <h3>
                  {formatDate(current.outbound)}
                  {current.ret ? ` → ${formatDate(current.ret)}` : ''}
                </h3>
                <div className="sort-bar" role="group" aria-label="Sort fares">
                  {(Object.keys(SORT_LABELS) as SortKey[]).map(key => (
                    <button
                      key={key}
                      type="button"
                      className="button"
                      aria-pressed={sort === key}
                      onClick={() => setSort(key)}
                    >
                      {SORT_LABELS[key]}
                    </button>
                  ))}
                </div>
              </div>
              {current.change ? (
                <p className="muted small">
                  {current.change.delta === 0
                    ? 'Price unchanged since the last check.'
                    : `${current.change.delta < 0 ? '↓' : '↑'} ${formatPrice(
                        Math.abs(current.change.delta),
                      )} since ${formatStamp(current.change.previous_fetched_at)}`}
                </p>
              ) : null}

              {rows.length === 0 ? (
                <EmptyNotice>No fares were parsed for this date.</EmptyNotice>
              ) : (
                <ul className="flight-list">
                  {rows.map((flight, index) => {
                    const best = flight.price === cheapestPrice;
                    return (
                      <li
                        key={`${flight.airline}-${flight.depTime}-${flight.price}-${index}`}
                        className={best ? 'flight flight--best' : 'flight'}
                      >
                        <span className="flight-cost">
                          <span className="flight-price num">{formatPrice(flight.price)}</span>
                          <a
                            className="flight-source"
                            href={current.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open this search on Google Flights"
                            aria-label={`Open the Google Flights search for ${flight.airline} ${formatPrice(flight.price)}, departing ${flight.depTime}`}
                          >
                            ↗
                          </a>
                        </span>
                        <span className="flight-airline">
                          {flight.airline}
                          {best ? <span className="badge badge--best">cheapest</span> : null}
                        </span>
                        <span
                          className="flight-times num"
                          title={`${flight.depAirport} → ${flight.arrAirport}`}
                        >
                          {flight.depTime} <span className="flight-arrow">→</span> {flight.arrTime}
                        </span>
                        <span className="flight-duration num">{flight.duration}</span>
                        <span className="flight-stops">{flight.stops}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
