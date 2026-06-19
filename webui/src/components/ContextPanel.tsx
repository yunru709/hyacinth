import { useState, useEffect } from 'react';
import { useStore } from '../store';

export function ContextPanel() {
  const tokensUsed = useStore(s => s.tokensUsed);
  const maxTokens = useStore(s => s.maxTokens);
  const cacheHitRate = useStore(s => s.cacheHitRate);
  const compressCount = useStore(s => s.compressCount);
  const turnCount = useStore(s => s.turnCount);
  const maxTurns = useStore(s => s.maxTurns);
  const config = useStore(s => s.config);
  const webuiConfig = useStore(s => s.webuiConfig);
  const configSaving = useStore(s => s.configSaving);
  const fetchConfig = useStore(s => s.fetchConfig);
  const patchConfig = useStore(s => s.patchConfig);

  const [editMaxContext, setEditMaxContext] = useState<number>(0);
  const [editMaxTurns, setEditMaxTurns] = useState<number>(0);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (webuiConfig) {
      setEditMaxContext(webuiConfig.maxContext);
      setEditMaxTurns(webuiConfig.maxTurns);
    }
  }, [webuiConfig]);

  const ratio = Math.min(tokensUsed / Math.max(maxTokens, 1), 1);
  const pct = (ratio * 100).toFixed(0);
  const barColor = ratio > 0.8 ? 'var(--danger)' : ratio > 0.5 ? 'var(--warning)' : 'var(--success)';

  const handleSave = async () => {
    await patchConfig({
      'session.maxContext': editMaxContext,
      'session.maxTurns': editMaxTurns,
    });
  };

  return (
    <div className="space-y-4">
      {/* Token usage */}
      <div className="card p-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Token 用量</div>
        <div className="flex justify-between gap-3">
          <span style={{ color: 'var(--muted)' }}>已用</span>
          <span className="font-mono" style={{ color: 'var(--text)' }}>{tokensUsed.toLocaleString()}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span style={{ color: 'var(--muted)' }}>上限</span>
          <span className="font-mono" style={{ color: 'var(--text)' }}>{maxTokens.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${ratio * 100}%`, background: barColor }} />
          </div>
          <span className="text-xs font-mono" style={{ color: 'var(--text)' }}>{pct}%</span>
        </div>
      </div>

      {/* Cache & Compression */}
      <div className="card p-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>缓存与压缩</div>
        <div className="flex justify-between gap-3">
          <span style={{ color: 'var(--muted)' }}>缓存命中率</span>
          <span className="font-mono" style={{ color: cacheHitRate != null && cacheHitRate > 50 ? 'var(--success)' : 'var(--text)' }}>
            {cacheHitRate != null ? `${cacheHitRate.toFixed(0)}%` : 'N/A'}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span style={{ color: 'var(--muted)' }}>压缩次数</span>
          <span className="font-mono" style={{ color: compressCount > 0 ? 'var(--warning)' : 'var(--text)' }}>{compressCount}</span>
        </div>
      </div>

      {/* Turns */}
      <div className="card p-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>回合</div>
        <div className="flex justify-between gap-3">
          <span style={{ color: 'var(--muted)' }}>当前</span>
          <span className="font-mono" style={{ color: 'var(--text)' }}>{turnCount}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span style={{ color: 'var(--muted)' }}>上限</span>
          <span className="font-mono" style={{ color: 'var(--text)' }}>{maxTurns}</span>
        </div>
      </div>

      {/* Editable limits */}
      <div className="card p-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>编辑限制</div>
        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>最大上下文 (tokens)</label>
          <input
            type="number"
            className="input"
            value={editMaxContext}
            onChange={e => setEditMaxContext(Number(e.target.value))}
            min={1000}
            step={1000}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px]" style={{ color: 'var(--muted)' }}>最大回合</label>
          <input
            type="number"
            className="input"
            value={editMaxTurns}
            onChange={e => setEditMaxTurns(Number(e.target.value))}
            min={1}
            step={1}
          />
        </div>
        <button
          className="btn btn-primary btn-sm w-full justify-center"
          onClick={handleSave}
          disabled={configSaving}
        >
          {configSaving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
}