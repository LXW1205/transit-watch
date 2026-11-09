/** Display helpers. Instants are UTC on the wire; GTFS service times are KL wall-clock. */

const TIME_ZONE = 'Asia/Kuala_Lumpur';

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const minuteFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const stampFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** `2026-11-09T14:55:06.000Z` → `14:55:06` (Kuala Lumpur). */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : clockFormat.format(date);
}

/** `2026-11-09T14:55:06.000Z` → `14:55` (Kuala Lumpur). */
export function formatMinute(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : minuteFormat.format(date);
}

/** `2026-11-09T14:55:06.000Z` → `09 Nov, 14:55` (Kuala Lumpur). */
export function formatStamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : stampFormat.format(date);
}

/** `06:45:00` → `06:45`; values past midnight (`25:10:00`) keep their GTFS hour. */
export function formatServiceTime(serviceTime: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(serviceTime);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : serviceTime;
}

/** `2026-11-18` → `Wed 18 Nov`. */
export function formatDate(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  }).format(date);
}

/** `1 hr 10 min` → 70; unparseable durations sort last. */
export function durationMinutes(text: string): number {
  const hours = /(\d+)\s*hr/i.exec(text);
  const minutes = /(\d+)\s*min/i.exec(text);
  if (!hours && !minutes) return Number.POSITIVE_INFINITY;
  return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
}

/** `10:00 AM` → 600 (minutes since midnight); unparseable times sort last. */
export function timeOfDayMinutes(text: string): number {
  const match = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(text.trim());
  if (!match) return Number.POSITIVE_INFINITY;
  let hours = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'P') hours += 12;
  return hours * 60 + Number(match[2]);
}

export function formatPrice(price: number): string {
  return `$${price.toLocaleString('en-US')}`;
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'age unknown';
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}
