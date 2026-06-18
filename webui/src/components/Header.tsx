import { useStore } from '../store';

export function Header() {
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
