interface InitializationErrorCardProps {
  error: string;
  onRetry: () => void;
  onOpenSettings: () => void;
}

const MAX_ERROR_LEN = 200;

export function InitializationErrorCard({ error, onRetry, onOpenSettings }: InitializationErrorCardProps) {
  const summary = error.length > MAX_ERROR_LEN ? error.slice(0, MAX_ERROR_LEN) + '…' : error;

  const handleViewLogs = () => {
    try {
      window.open('/api/health', '_blank', 'noopener,noreferrer');
    } catch {
      // eslint-disable-next-line no-console
      console.log('[InitializationError] 原始错误:', error);
    }
  };

  return (
    <div className="card p-4 mx-4 my-3" style={{ background: 'var(--surface)', borderColor: 'var(--danger)' }}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
          style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--danger)' }}>
          !
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm" style={{ color: 'var(--text)' }}>初始化失败</div>
          <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            无法为当前会话创建必要的工作目录，Agent 暂时不可用。
          </p>
          <div className="mt-2 px-2.5 py-1.5 rounded text-[11px] font-mono break-all"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
            {summary}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button onClick={onRetry} className="btn btn-primary btn-sm">重试</button>
            <button onClick={onOpenSettings} className="btn btn-sm">打开设置</button>
            <button onClick={handleViewLogs} className="btn btn-ghost btn-sm">查看日志</button>
          </div>
        </div>
      </div>
    </div>
  );
}
