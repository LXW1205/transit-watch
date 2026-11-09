import type { ReactNode } from 'react';
import type { ApiError } from '../api';

export function Loading({ label }: { label: string }) {
  return (
    <p className="notice notice--loading" role="status">
      {label}
    </p>
  );
}

export function ErrorNotice({
  error,
  onRetry,
  compact = false,
}: {
  error: ApiError;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? 'notice notice--error notice--compact' : 'notice notice--error'}
      role="alert"
    >
      <div>
        <strong>{error.status ? `Request failed (HTTP ${error.status})` : 'Request failed'}</strong>
        <p>{error.detail || error.message}</p>
        <p className="notice-reason">
          <code>{error.reason}</code>
        </p>
      </div>
      {onRetry ? (
        <button type="button" className="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyNotice({ children }: { children: ReactNode }) {
  return <p className="notice">{children}</p>;
}

export function WarnNotice({ children }: { children: ReactNode }) {
  return (
    <p className="notice notice--warn" role="status">
      {children}
    </p>
  );
}
