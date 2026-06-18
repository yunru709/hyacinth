import { useStore } from '../store';

export function Header() {
  const connected = useStore((s) => s.connected);
  const config = useStore((s) => s.config);
  const turnCount = useStore((s) => s.turnCount);
  const maxTurns = useStore((s) => s.maxTurns);
  const tokensUsed = useStore((s) => s.tokensUsed);
  const maxTokens = useStore((s) => s.maxTokens);
  const cacheHitRate = useStore((s) => s.cacheHitRate);
  const compressCount = useStore((s) => s.compressCount);

  const ratio = Math.min(tokensUsed / Math.max(maxTokens, 1), 1);
  const filledW = Math.floor(ratio * 40);
  const emptyW = 40 - filledW;
  const pct = (ratio * 100).toFixed(0);

  let barColor = 'bg-green-500';
  if (ratio > 0.8) barColor = 'bg-red-500';
  else if (ratio > 0.5) barColor = 'bg-yellow-500';

  return (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-2 bg-surface">
      {/* Status line */}
      <div className="flex items-center gap-3 text-sm flex-wrap">
        <span className="font-bold text-accent">DeepThink</span>

        {/* Connection dot */}
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            connected ? 'bg-green-500' : 'bg-red-500'
          }`}
          title={connected ? 'Connected' : 'Disconnected'}
        />

        {config && (
          <>
            <span className="text-muted">·</span>
            <span className="text-accent">{config.model}</span>
            <span className="text-muted">·</span>
            <span className="text-text">
              Turns: <span className="font-mono">{turnCount}</span>/{maxTurns}
            </span>
            {compressCount > 0 && (
              <>
                <span className="text-muted">·</span>
                <span className="text-yellow-500">Compr: {compressCount}</span>
              </>
            )}
          </>
        )}
      </div>

      {/* Context bar */}
      <div className="flex items-center gap-2 text-xs font-mono">
        <span className="text-muted">Context:</span>
        <span className="inline-flex">
          <span className={`${barColor} text-transparent`}>
            {'█'.repeat(filledW)}
          </span>
          <span className="text-border">
            {'░'.repeat(emptyW)}
          </span>
        </span>
        <span className="text-text">{pct}%</span>
        <span className="text-muted">
          ({(tokensUsed / 1000).toFixed(0)}K / {(maxTokens / 1000).toFixed(0)}K)
        </span>
        {cacheHitRate != null && (
          <span className="text-muted">
            Cache: {cacheHitRate.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
