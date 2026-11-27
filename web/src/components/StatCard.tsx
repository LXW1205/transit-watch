import type { ReactNode } from 'react';

/**
 * StatCard — the look's page vocabulary (docs/DESIGN.md §9).
 * One number with its label, optionally a caption.
 */
export function StatCard({
  value,
  label,
  caption,
  index = 0,
}: {
  value: ReactNode;
  label: string;
  caption?: ReactNode;
  index?: number;
}) {
  return (
    <div className="stat rs-enter" style={{ ['--i' as string]: index }}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {caption ? <span className="stat-caption">{caption}</span> : null}
    </div>
  );
}
