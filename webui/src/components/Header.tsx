import { useStore } from '../store';

/** 检测 provider 与 model 名称是否可能不匹配 */
function isProviderModelMismatch(provider: string, model: string): boolean {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();
  if (m.includes('claude') && p !== 'anthropic') return true;
  if (m.includes('gpt') && p !== 'openai') return true;
  if (m.includes('deepseek') && p !== 'deepseek') return true;
  if (m.includes('gemini') && p !== 'gemini' && p !== 'google') return true;
  if (m.includes('grok') && p !== 'xai' && p !== 'grok') return true;
  if (m.includes('mistral') && p !== 'mistral') return true;
  return false;
}

export function Header({ sendMode }: { sendMode: (mode: 'normal' | 'precise') => void }) {
  const connected = useStore(s => s.connected);
  const ready = useStore(s => s.ready);
  const config = useStore(s => s.config);
  const tokensUsed = useStore(s => s.tokensUsed);
  const maxTokens = useStore(s => s.maxTokens);
  const cacheHitRate = useStore(s => s.cacheHitRate);
  const setActiveActivity = useStore(s => s.setActiveActivity);
  const openInspector = useStore(s => s.openInspector);
  const openPanel = useStore(s => s.openPanel);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const mode = useStore(s => s.mode);
  const isProcessing = useStore(s => s.isProcessing);

  const ratio = Math.min(tokensUsed / Math.max(maxTokens, 1), 1);
  const pct = (ratio * 100).toFixed(0);
  const barColor = ratio > 0.8 ? 'var(--danger)' : ratio > 0.5 ? 'var(--warning)' : 'var(--success)';

  return (
    <div className="flex flex-col gap-1 px-4 py-2.5 border-b flex-shrink-0" style={{background:'var(--surface)', borderColor:'var(--border)'}}>
      {/* Top row */}
      <div className="flex items-center gap-3 text-sm flex-wrap">
        <button onClick={() => setActiveActivity('sessions')} className="font-bold tracking-tight" style={{color:'var(--accent)', fontSize:15, background:'transparent', border:'none', cursor:'pointer'}}>DeepThink</button>

        {!sidebarOpen && (
          <button onClick={() => setActiveActivity('sessions')} className="btn-ghost btn-sm" title="显示会话面板">☰</button>
        )}

        {config && (
          <>
            <button onClick={() => { setActiveActivity('model'); openPanel('models'); }} className="inline-flex items-center gap-1.5 text-xs rounded-md px-2 py-1 transition-colors" style={{color:'var(--text-dim)', background:'var(--bg)', border:'1px solid var(--border)'}} title="打开模型中心">
              <span className="w-1.5 h-1.5 rounded-full"
                    style={{background: connected ? (ready ? 'var(--success)' : 'var(--warning)') : 'var(--danger)'}} />
              <span className="truncate">{config.provider}</span>
              <span style={{color:'var(--muted)'}}>/</span>
              <span className="truncate" style={{color: isProviderModelMismatch(config.provider, config.model) ? 'var(--warning)' : 'var(--text-dim)'}}>{config.model}</span>
            </button>

            <div className="inline-flex items-center gap-1.5" title="模式切换">
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
                    title={`切换到 ${m === 'normal' ? '普通' : '精确'} 模式`}
                  >
                    {m === 'normal' ? '普通' : '精确'}
                  </button>
                ))}
              </div>
              {mode === 'precise' && (
                <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide" style={{color:'var(--accent)'}}>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{background:'var(--accent)'}} />
                  精确
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Context bar */}
      <button onClick={() => { setActiveActivity('context'); openPanel('context'); }} className="flex items-center gap-2 text-xs font-mono text-left rounded-md" title="打开上下文面板">
        <span style={{color:'var(--muted)'}}>上下文</span>
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{background:'var(--border)', maxWidth: 220}}>
          <div className="h-full rounded-full transition-all duration-300" style={{width: `${ratio*100}%`, background: barColor}} />
        </div>
        <span style={{color:'var(--text)'}}>{pct}%</span>
        <span style={{color:'var(--muted)'}}>{(tokensUsed/1000).toFixed(0)}K/{(maxTokens/1000).toFixed(0)}K</span>
        {cacheHitRate != null && (
          <span style={{color:'var(--muted)'}}>缓存 {cacheHitRate.toFixed(0)}%</span>
        )}
      </button>
    </div>
  );
}
