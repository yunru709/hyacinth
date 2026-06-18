import { useState } from 'react';
import { useStore } from '../store';
import type { SessionInfo } from '../types';

/** 从 session ID 或 channel 字段检测渠道 */
function detectChannel(s: SessionInfo): string {
  if (s.channel) return s.channel;
  if (/^feishu_|^feishu-/.test(s.id)) return 'feishu';
  if (/^webui-/.test(s.id)) return 'webui';
  return 'tui';
}

const CHANNEL_META: Record<string, { label: string; icon: string }> = {
  webui: { label: 'Web UI', icon: '🌐' },
  tui: { label: 'Terminal', icon: '⬛' },
  feishu: { label: 'Feishu', icon: '💬' },
};

export function Sidebar({ switchSession }: { switchSession: (id: string) => void }) {
  const sessions = useStore(s => s.sessions);
  const activeSessionId = useStore(s => s.sessionId);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const toggleSidebar = useStore(s => s.toggleSidebar);
  const theme = useStore(s => s.theme);
  const toggleTheme = useStore(s => s.toggleTheme);
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  // 默认展开所有 channel section
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!sidebarOpen) {
    return (
      <div className="flex flex-col items-center py-3 gap-3 border-r flex-shrink-0" style={{width:44, borderColor:'var(--border)', background:'var(--surface)'}}>
        <button onClick={toggleSidebar} className="btn-ghost btn-sm" title="Expand sidebar">☰</button>
        <button onClick={toggleTheme} className="btn-ghost btn-sm" title="Toggle theme">{theme === 'dark' ? '☀' : '☾'}</button>
      </div>
    );
  }

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/sessions', { method: 'POST' });
      const data = await res.json();
      const listRes = await fetch('/api/sessions');
      const list = await listRes.json();
      useStore.getState().setSessions(list);
      useStore.setState({ activeSessionId: data.id });
      useStore.getState().addSystemMsg(`New session created`, 'info');
    } catch {
      useStore.getState().addSystemMsg('Failed to create session', 'error');
    }
    setCreating(false);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete session ${id.slice(0, 10)}...?`)) return;
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      const listRes = await fetch('/api/sessions');
      const list = await listRes.json();
      useStore.getState().setSessions(list);
      if (activeSessionId === id) {
        useStore.setState({ activeSessionId: list[0]?.id ?? null });
      }
      useStore.getState().addSystemMsg(`Session deleted`, 'info');
    } catch {
      useStore.getState().addSystemMsg('Failed to delete session', 'error');
    }
  };

  const handleSelect = async (id: string) => {
    if (id === useStore.getState().sessionId) return; // 已经是当前 session
    setSwitching(id);
    try {
      // 1. 加载历史事件
      const res = await fetch(`/api/sessions/${id}/events?limit=50`);
      if (res.ok) {
        const events = await res.json();
        if (Array.isArray(events) && events.length > 0) {
          useStore.getState().loadHistory(events);
          useStore.getState().addSystemMsg(`Loaded ${events.length} events from session`, 'info');
        } else {
          useStore.setState({ messages: [], currentText: '', currentThinking: '', pendingThinking: '' });
          useStore.getState().addSystemMsg('Empty session', 'info');
        }
      } else {
        useStore.setState({ messages: [], currentText: '', currentThinking: '', pendingThinking: '' });
      }
      // 2. 通知后端切换 session
      useStore.setState({ activeSessionId: id });
      switchSession(id);
    } catch {
      useStore.getState().addSystemMsg('Failed to load session history', 'error');
    }
    setSwitching(null);
  };

  const toggleChannel = (ch: string) => {
    setCollapsed(prev => ({ ...prev, [ch]: !prev[ch] }));
  };

  const formatDate = (d: string) => {
    const dt = new Date(d);
    const diff = Date.now() - dt.getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return dt.toLocaleDateString();
  };

  // 分组
  const grouped: Record<string, SessionInfo[]> = {};
  for (const s of sessions) {
    const ch = detectChannel(s);
    if (!grouped[ch]) grouped[ch] = [];
    grouped[ch].push(s);
  }
  // 排序：webui 在前，tui 其次，feishu 最后
  const channelOrder = ['webui', 'tui', 'feishu'];
  const channels = channelOrder.filter(ch => grouped[ch]?.length > 0);

  return (
    <div className="flex flex-col flex-shrink-0" style={{width: 250, background:'var(--surface)', borderRight:'1px solid var(--border)'}}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b" style={{borderColor:'var(--border)'}}>
        <span className="font-semibold text-sm" style={{color:'var(--text)'}}>Sessions</span>
        <div className="flex gap-1">
          <button onClick={toggleTheme} className="btn-ghost btn-sm">{theme === 'dark' ? '☀' : '☾'}</button>
          <button onClick={toggleSidebar} className="btn-ghost btn-sm">◁</button>
        </div>
      </div>

      {/* New Session */}
      <div className="px-3 py-2">
        <button onClick={handleCreate} disabled={creating} className="btn btn-primary btn-sm w-full justify-center">
          {creating ? '⏳' : '+'} New Session
        </button>
      </div>

      {/* Channel sections */}
      <div className="flex-1 overflow-y-auto" style={{minHeight:0}}>
        {channels.length === 0 && (
          <div className="text-xs px-3 py-3" style={{color:'var(--muted)'}}>No sessions</div>
        )}

        {channels.map(ch => {
          const meta = CHANNEL_META[ch] || { label: ch, icon: '📡' };
          const isCollapsed = collapsed[ch] || false;
          const chSessions = grouped[ch];
          return (
            <div key={ch}>
              {/* Channel header */}
              <button
                onClick={() => toggleChannel(ch)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors sticky top-0 z-10"
                style={{background:'var(--surface)', color:'var(--text-dim)', borderBottom:'1px solid var(--border)'}}
              >
                <span className="text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
                <span>{meta.icon}</span>
                <span>{meta.label}</span>
                <span className="ml-auto opacity-50">{chSessions.length}</span>
              </button>

              {/* Session list */}
              {!isCollapsed && chSessions.map(s => {
                const isActive = s.id === activeSessionId || s.id === useStore.getState().sessionId;
                return (
                  <div
                    key={s.id}
                    onClick={() => handleSelect(s.id)}
                    className="group flex items-center gap-2 px-2 pl-7 py-1.5 cursor-pointer transition-colors text-xs"
                    style={{
                      background: isActive ? 'var(--accent)' : 'transparent',
                      color: isActive ? '#fff' : 'var(--text)',
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--surface-hover)'; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span className="flex-1 truncate font-mono text-[11px]">{s.id.slice(0, 12)}...</span>
                    <span className="flex-shrink-0 text-[10px]" style={{color: isActive ? 'rgba(255,255,255,0.5)' : 'var(--muted)'}}>
                      {formatDate(s.createdAt)}
                    </span>
                    <button
                      onClick={(e) => handleDelete(s.id, e)}
                      className="btn-ghost btn-sm opacity-0 group-hover:opacity-100 flex-shrink-0"
                      style={{color: isActive ? 'rgba(255,255,255,0.6)' : 'var(--danger)', padding:'1px 4px', fontSize:10}}
                    >✕</button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t text-[11px]" style={{borderColor:'var(--border)', color:'var(--muted)'}}>
        {sessions.length} session{sessions.length !== 1 ? 's' : ''} · {channels.length} channel{channels.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
