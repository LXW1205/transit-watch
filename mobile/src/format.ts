/** Display helpers. Times are shown in the service's timezone (Asia/Kuala_Lumpur). */

const KL = 'Asia/Kuala_Lumpur';

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: KL,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: KL,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

export const formatClock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : clockFormat.format(d);
};

export const formatDate = (iso: string): string => {
  // A bare YYYY-MM-DD is a calendar date, not an instant — keep it out of UTC math.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00+08:00`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
};

export const formatPrice = (value: number): string => `$${value.toLocaleString('en-US')}`;

export const formatAge = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return 'age unknown';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

/** `HH:MM:SS` from GTFS, where hours may pass 24:00 for after-midnight trips. */
export const formatServiceTime = (clock: string): string => clock.slice(0, 5);
