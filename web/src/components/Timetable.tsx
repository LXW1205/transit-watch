import { useMemo } from 'react';
import { formatServiceTime } from '../format';
import { EmptyNotice } from './Notice';
import type { Direction, Trip } from '../types';

interface ServiceGroup {
  serviceId: string;
  label: string;
  kind: 'weekday' | 'weekend' | null;
  trips: Trip[];
}

function classify(label: string): 'weekday' | 'weekend' | null {
  const text = label.toLowerCase();
  if (/weekend|saturday|sunday|sat-sun/.test(text)) return 'weekend';
  if (/weekday|monday|tuesday|wednesday|thursday|friday|mon-fri/.test(text)) return 'weekday';
  return null;
}

function groupTrips(trips: Trip[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const trip of trips) {
    const existing = groups.get(trip.serviceId);
    if (existing) {
      existing.trips.push(trip);
      continue;
    }
    const label = trip.serviceLabel?.trim() || `Service ${trip.serviceId}`;
    groups.set(trip.serviceId, {
      serviceId: trip.serviceId,
      label,
      kind: classify(label),
      trips: [trip],
    });
  }
  const rank = (group: ServiceGroup) => (group.kind === 'weekday' ? 0 : group.kind === 'weekend' ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** Per-trip timetable for one direction, grouped by service so 80 trips stay readable. */
export function Timetable({ direction }: { direction: Direction }) {
  const groups = useMemo(() => groupTrips(direction.trips), [direction.trips]);

  if (direction.trips.length === 0) {
    return <EmptyNotice>No scheduled trips are published for this direction.</EmptyNotice>;
  }

  return (
    <div className="timetable">
      <p className="muted small">
        {direction.trips.length} trips · {direction.headsign || `Direction ${direction.id}`} ·
        times are Asia/Kuala_Lumpur service times (a value past 24:00 is after midnight).
      </p>
      {groups.map(group => (
        <section className="service-group" key={group.serviceId}>
          <header className="service-head">
            <h3>{group.label}</h3>
            {group.kind ? <span className={`tag tag--${group.kind}`}>{group.kind}</span> : null}
            <span className="muted small">{group.trips.length} trips</span>
            {group.kind ? null : <code className="muted small">{group.serviceId}</code>}
          </header>
          <ol className="trip-grid">
            {group.trips.map(trip => (
              <li className="trip" key={trip.tripId} title={`${trip.firstDeparture} → ${trip.lastArrival}`}>
                <span className="trip-dep">{formatServiceTime(trip.firstDeparture)}</span>
                <span className="trip-arrow">→</span>
                <span className="trip-arr">{formatServiceTime(trip.lastArrival)}</span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
