import { useStore } from '../store';

export function Header({ sendMode }: { sendMode: (mode: 'normal' | 'precise') => void }) {
  const connected = useStore(s => s.connected);
  const ready = useStore(s => s.ready);
  const config = useStore(s => s.config);
  const turnCount = useStore(s => s.turnCount);
  const maxTurns = useStore(s => s.maxTurns);
  const tokensUsed = useStore(s => s.tokensUsed);
  const maxTokens = useStore(s => s.maxTokens);
  const cacheHitRate = useStore(s => s.cacheHitRate);
  const compressCount = useStore(s => s.compressCount);
  const toggleSidebar = useStore(s => s.toggleSidebar);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const mode = useStore(s => s.mode);
  const isProcessing = useStore(s => s.isProcessing);

  const ratio = Math.min(tokensUsed / Math.max(maxTokens, 1), 1);
  const pct = (ratio * 100).toFixed(0);
  let barColor = ratio > 0.8 ? 'var(--danger)' : ratio > 0.5 ? 'var(--warning)' : 'var(--success)';

  return (
    <div className="flex flex-col gap-1 px-4 py-2.5 border-b flex-shrink-0" style={{background:'var(--surface)', borderColor:'var(--border)'}}>
      {/* Top row */}
      <div className="flex items-center gap-3 text-sm flex-wrap">
        {!sidebarOpen && (
          <button onClick={toggleSidebar} className="btn-ghost btn-sm" title="Show sidebar">☰</button>
        )}
        <span className="font-bold tracking-tight" style={{color:'var(--accent)', fontSize:15}}>DeepThink</span>

        {config && (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs" style={{color:'var(--text-dim)'}}>
              <span className="w-1.5 h-1.5 rounded-full"
                    style={{background: connected ? (ready ? 'var(--success)' : 'var(--warning)') : 'var(--danger)'}} />
              {config.model}
            </span>

            <span className="text-xs font-mono" style={{color:'var(--text-dim)'}}>
              Turn {turnCount}/{maxTurns}
            </span>

            {compressCount > 0 && (
              <span className="text-xs" style={{color:'var(--warning)'}}>Compr: {compressCount}</span>
            )}

            <div className="inline-flex items-center gap-1.5">
              <div
                className="inline-flex rounded-md overflow-hidden border"
                style={{
                  borderColor: mode === 'precise' ? 'var(--accent)' : 'var(--border)',
                  boxShadow: mode === 'precise' ? '0 0 0 1px var(--accent)' : 'none',
                }}
              >
                {(['normal', 'precise'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => sendMode(m)}
                    disabled={!connected || !ready || isProcessing || mode === m}
                    className="px-2 py-0.5 text-[11px] capitalize transition-colors"
                    style={{
                      background: mode === m ? 'var(--accent)' : 'transparent',
                      color: mode === m ? '#fff' : 'var(--text-dim)',
                      opacity: (!connected || !ready || isProcessing) && mode !== m ? 0.5 : 1,
                    }}
                    title={`Switch to ${m} mode`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              {mode === 'precise' && (
                <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide" style={{color:'var(--accent)'}}>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{background:'var(--accent)'}} />
                  Precise
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Context bar */}
      <div className="flex items-center gap-2 text-xs font-mono">
        <span style={{color:'var(--muted)'}}>Context</span>
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{background:'var(--border)', maxWidth: 220}}>
          <div className="h-full rounded-full transition-all duration-300" style={{width: `${ratio*100}%`, background: barColor}} />
        </div>
        <span style={{color:'var(--text)'}}>{pct}%</span>
        <span style={{color:'var(--muted)'}}>{(tokensUsed/1000).toFixed(0)}K/{(maxTokens/1000).toFixed(0)}K</span>
        {cacheHitRate != null && (
          <span style={{color:'var(--muted)'}}>Cache {cacheHitRate.toFixed(0)}%</span>
        )}
      </div>
    </div>
  );
}
