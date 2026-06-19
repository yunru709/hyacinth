import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';

interface KbStats {
  totalEntries: number;
}

interface KbResult {
  id?: string;
  title?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface KbQueryResponse {
  results: KbResult[];
}

export function KnowledgePanel() {
  const [stats, setStats] = useState<KbStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KbResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // 从 store 读取 KB 配置
  const webuiConfig = useStore(s => s.webuiConfig);
  const patchConfig = useStore(s => s.patchConfig);
  const fetchConfig = useStore(s => s.fetchConfig);
  const configSaving = useStore(s => s.configSaving);
  const toast = useStore(s => s.toast);

  const kbEnabled = webuiConfig?.kb?.enabled ?? false;
  const zone4Enabled = webuiConfig?.kb?.zone4 ?? false;

  // 确保配置已加载
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await fetch('/api/kb/stats');
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        setStatsError(err.error ?? 'Failed to fetch KB stats');
        return;
      }
      const data: KbStats = await res.json();
      setStats(data);
    } catch {
      setStatsError('Network error fetching KB stats');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearched(true);
    setSearchError(null);
    setResults([]);
    try {
      const res = await fetch(`/api/kb/query?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        setSearchError(err.error ?? 'Search failed');
        return;
      }
      const data: KbQueryResponse = await res.json();
      setResults(data.results ?? []);
    } catch {
      setSearchError('Network error during search');
    } finally {
      setSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto" style={{minHeight: 0}}>
      {/* Toast feedback */}
      {toast && (
        <div className="m-3 mb-0 px-3 py-2 rounded-md text-xs font-medium"
             style={{background: toast.type === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                     color: toast.type === 'success' ? 'var(--success)' : 'var(--danger)',
                     border: `1px solid ${toast.type === 'success' ? 'var(--success)' : 'var(--danger)'}`}}>
          {toast.message}
        </div>
      )}

      {/* Status Toggles */}
      <div className="p-3 space-y-2 border-b" style={{borderColor: 'var(--border)'}}>
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color: 'var(--muted)'}}>状态</div>

        {/* KB Enabled */}
        <div className="flex items-center justify-between">
          <div className="text-xs" style={{color: 'var(--text)'}}>KB 已启用</div>
          <button
            onClick={() => patchConfig({ 'kb.enabled': !kbEnabled })}
            className="w-8 h-5 rounded-full relative transition-colors"
            style={{
              background: kbEnabled ? 'var(--accent)' : 'var(--border)',
              opacity: configSaving ? 0.5 : 1,
              cursor: configSaving ? 'not-allowed' : 'pointer',
            }}
            disabled={configSaving}
            title={kbEnabled ? '已启用' : '已禁用'}
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ left: kbEnabled ? 'calc(100% - 18px)' : '2px' }}
            />
          </button>
        </div>

        {/* Zone4 Enabled */}
        <div className="flex items-center justify-between">
          <div className="text-xs" style={{color: 'var(--text)'}}>Zone4 已启用</div>
          <button
            onClick={() => patchConfig({ 'kb.zone4': !zone4Enabled })}
            className="w-8 h-5 rounded-full relative transition-colors"
            style={{
              background: zone4Enabled ? 'var(--accent)' : 'var(--border)',
              opacity: configSaving ? 0.5 : 1,
              cursor: configSaving ? 'not-allowed' : 'pointer',
            }}
            disabled={configSaving}
            title={zone4Enabled ? '已启用' : '已禁用'}
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ left: zone4Enabled ? 'calc(100% - 18px)' : '2px' }}
            />
          </button>
        </div>
      </div>

      {/* KB Stats */}
      <div className="p-3 space-y-2 border-b" style={{borderColor: 'var(--border)'}}>
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color: 'var(--muted)'}}>统计</div>
        {statsLoading && (
          <div className="text-xs" style={{color: 'var(--muted)'}}>加载统计中...</div>
        )}
        {statsError && (
          <div className="text-xs" style={{color: 'var(--danger)'}}>{statsError}</div>
        )}
        {stats && !statsLoading && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span style={{color: 'var(--muted)'}}>条目</span>
              <span style={{color: 'var(--text)'}}>{stats.totalEntries}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span style={{color: 'var(--muted)'}}>KB</span>
              <span style={{color: kbEnabled ? 'var(--success)' : 'var(--muted)'}}>{kbEnabled ? '已启用' : '已禁用'}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span style={{color: 'var(--muted)'}}>Zone4</span>
              <span style={{color: zone4Enabled ? 'var(--success)' : 'var(--muted)'}}>{zone4Enabled ? '已启用' : '已禁用'}</span>
            </div>
          </div>
        )}
        <button
          onClick={fetchStats}
          disabled={statsLoading}
          className="btn btn-sm btn-ghost w-full text-[11px]"
          style={{color: 'var(--muted)'}}
        >
          ↻ 刷新
        </button>
      </div>

      {/* Search */}
      <div className="p-3 space-y-2 border-b" style={{borderColor: 'var(--border)'}}>
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color: 'var(--muted)'}}>搜索</div>
        <div className="flex gap-1.5">
          <input
            type="text"
            className="input flex-1"
            placeholder="搜索知识库..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{fontSize: 12}}
          />
          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="btn btn-primary btn-sm flex-shrink-0"
          >
            {searching ? '...' : '搜索'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 p-3 overflow-y-auto" style={{minHeight: 0}}>
        {searching && (
          <div className="text-xs text-center py-4" style={{color: 'var(--muted)'}}>搜索中...</div>
        )}
        {searchError && (
          <div className="text-xs p-2 rounded" style={{background: 'var(--danger)', color: '#fff'}}>{searchError}</div>
        )}
        {!searching && !searchError && searched && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="text-2xl mb-2 opacity-30">🔍</div>
            <div className="text-xs" style={{color: 'var(--muted)'}}>未找到结果</div>
            <div className="text-[11px] mt-1" style={{color: 'var(--muted)', opacity: 0.7}}>
              尝试其他关键词
            </div>
          </div>
        )}
        {!searching && !searchError && results.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-medium" style={{color: 'var(--muted)'}}>
              {results.length} 条结果
            </div>
            {results.map((r, i) => (
              <div key={r.id ?? i} className="card p-2.5 space-y-1">
                {(r.title || r.id) && (
                  <div className="text-xs font-medium truncate" style={{color: 'var(--text)'}}>
                    {r.title || r.id}
                  </div>
                )}
                {r.content && (
                  <div className="text-[11px] leading-relaxed" style={{color: 'var(--text-dim)'}}>
                    {r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content}
                  </div>
                )}
                {r.score !== undefined && (
                  <div className="text-[10px]" style={{color: 'var(--muted)'}}>
                    相关性: {r.score.toFixed(3)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {!searching && !searched && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="text-2xl mb-2 opacity-30">📚</div>
            <div className="text-xs" style={{color: 'var(--muted)'}}>输入关键词搜索</div>
            <div className="text-[11px] mt-1" style={{color: 'var(--muted)', opacity: 0.7}}>
              结果将显示在这里
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
