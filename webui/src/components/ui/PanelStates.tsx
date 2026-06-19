import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title?: string;
  text: string;
  hint?: string;
}

export function EmptyState({ icon, title, text, hint }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon != null ? (
        <span className="empty-state-icon">{icon}</span>
      ) : (
        <span className="empty-state-icon">🗂</span>
      )}
      {title && <span className="empty-state-title">{title}</span>}
      <span className="empty-state-text">{text}</span>
      {hint && <span className="empty-state-hint">{hint}</span>}
    </div>
  );
}

interface LoadingStateProps {
  text?: string;
}

export function LoadingState({ text = '加载中...' }: LoadingStateProps) {
  return (
    <div className="loading-state">
      <span className="loading-state-spinner" />
      <span className="loading-state-text">{text}</span>
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  error: string;
  onRetry?: () => void;
  retryText?: string;
}

export function ErrorState({ title = '加载失败', error, onRetry, retryText = '重试' }: ErrorStateProps) {
  return (
    <div className="error-state">
      <span className="error-state-icon">⚠</span>
      <span className="error-state-title">{title}</span>
      <span className="error-state-text">{error}</span>
      {onRetry && (
        <button onClick={onRetry} className="btn btn-sm btn-primary mt-2">
          {retryText}
        </button>
      )}
    </div>
  );
}
