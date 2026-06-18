import { useState } from 'react';
import { useStore } from '../store';

export function Sidebar() {
  const sessions = useStore(s => s.sessions);
  const activeSessionId = useStore(s => s.sessionId);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const toggleSidebar = useStore(s => s.toggleSidebar);
  const theme = useStore(s => s.theme);
  const toggleTheme = useStore(s => s.toggleTheme);
  const [creating, setCreating] = useState(false);

  if (!sidebarOpen) {
    return (
      <div className="flex flex-col items-center py-3 gap-3 border-r" style={{width:44, borderColor:'var(--border)', background:'var(--surface)'}}>
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
      // Reload sessions
      const listRes = await fetch('/api/sessions');
      const list = await listRes.json();
      useStore.getState().setSessions(list);
      // Switch to new session
      useStore.setState({ activeSessionId: data.id });
      useStore.getState().addSystemMsg(`Created session: ${data.id}`, 'info');
    } catch (e) {
      useStore.getState().addSystemMsg('Failed to create session', 'error');
    }
    setCreating(false);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete session ${id.slice(0, 8)}...?`)) return;
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      const listRes = await fetch('/api/sessions');
      const list = await listRes.json();
      useStore.getState().setSessions(list);
      if (activeSessionId === id) {
        useStore.setState({ activeSessionId: list[0]?.id ?? null });
      }
      useStore.getState().addSystemMsg(`Deleted session: ${id.slice(0, 8)}...`, 'info');
    } catch (e) {
      useStore.getState().addSystemMsg('Failed to delete session', 'error');
    }
  };

  const handleSelect = (id: string) => {
    useStore.setState({ activeSessionId: id });
    useStore.getState().addSystemMsg(`Switched to session: ${id.slice(0, 8)}...`, 'info');
    // Clear chat for the new session
    useStore.setState({ messages: [], currentText: '', currentThinking: '', pendingThinking: '' });
  };

  const formatDate = (d: string) => {
    const dt = new Date(d);
    const now = new Date();
    const diff = now.getTime() - dt.getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return dt.toLocaleDateString();
  };

  return (
    <div className="flex flex-col" style={{width: 240, background: 'var(--surface)', borderRight: '1px solid var(--border)'}}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b" style={{borderColor:'var(--border)'}}>
        <span className="font-semibold text-sm" style={{color:'var(--text)'}}>Sessions</span>
        <div className="flex gap-1">
          <button onClick={toggleTheme} className="btn-ghost btn-sm" title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button onClick={toggleSidebar} className="btn-ghost btn-sm" title="Collapse">◁</button>
        </div>
      </div>

      {/* New session button */}
      <div className="px-3 py-2">
        <button onClick={handleCreate} disabled={creating} className="btn btn-primary btn-sm w-full justify-center">
          {creating ? '⏳' : '+'} New Session
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 py-1" style={{minHeight:0}}>
        {sessions.length === 0 && (
          <div className="text-xs px-2 py-3" style={{color:'var(--muted)'}}>No sessions yet</div>
        )}
        {sessions.map(s => {
          const isActive = s.id === activeSessionId || s.id === (useStore.getState().sessionId);
          return (
            <div
              key={s.id}
              onClick={() => handleSelect(s.id)}
              className="group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors text-xs"
              style={{
                background: isActive ? 'var(--accent)' : 'transparent',
                color: isActive ? '#fff' : 'var(--text)',
                opacity: isActive ? 1 : 0.8,
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--surface-hover)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              <span className="flex-1 truncate font-mono">{s.id.slice(0, 10)}...</span>
              <span style={{color: isActive ? 'rgba(255,255,255,0.6)' : 'var(--muted)', flexShrink:0}}>{formatDate(s.createdAt)}</span>
              <button
                onClick={(e) => handleDelete(s.id, e)}
                className="btn-ghost btn-sm opacity-0 group-hover:opacity-100 transition-opacity"
                style={{color: isActive ? 'rgba(255,255,255,0.7)' : 'var(--danger)', flexShrink:0}}
                title="Delete"
              >✕</button>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t text-xs" style={{borderColor:'var(--border)', color:'var(--muted)'}}>
        {sessions.length} session{sessions.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
