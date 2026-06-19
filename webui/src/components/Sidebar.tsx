import { useState } from 'react';
import { useStore } from '../store';
import type { SessionInfo } from '../types';
import { KnowledgePanel } from './KnowledgePanel';
import { SchedulerPanel } from './SchedulerPanel';

/** 从 session ID 或 channel 字段检测渠道 */
function detectChannel(s: SessionInfo): string {
  if (s.channel) return CHANNEL_META[s.channel] ? s.channel : 'unknown';
  if (/^feishu_|^feishu-/.test(s.id)) return 'feishu';
  if (/^webui-/.test(s.id)) return 'webui';
  if (/^tui-/.test(s.id)) return 'tui';
  return 'legacy';
}

const CHANNEL_META: Record<string, { label: string; icon: string }> = {
  webui: { label: 'Web UI', icon: '🌐' },
  tui: { label: '终端', icon: '⬛' },
  feishu: { label: '飞书', icon: '💬' },
  legacy: { label: '其他', icon: '📁' },
  unknown: { label: '未知', icon: '❓' },
};

export function SessionsPanel({ switchSession }: { switchSession: (id: string) => void }) {
  const sessions = useStore(s => s.sessions);
  const activeSessionId = useStore(s => s.sessionId);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const activeActivity = useStore(s => s.activeActivity);
  const toggleSidebar = useStore(s => s.toggleSidebar);
  const [creating, setCreating] = useState(false);
  const [newSessionType, setNewSessionType] = useState<'normal' | 'precise'>('normal');
  const [switching, setSwitching] = useState<string | null>(null);
  // 默认展开所有 channel section
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!sidebarOpen) return null;

  if (activeActivity !== 'sessions') {
    const panelTitle: Record<string, string> = {
      model: '模型中心',
      context: '上下文',
      knowledge: '知识库',
      scheduler: '调度',
      settings: '设置',
    };

    return (
      <div className="flex flex-col flex-shrink-0" style={{width: 250, background:'var(--surface)', borderRight:'1px solid var(--border)'}}>
        <div className="flex items-center justify-between px-3 py-3 border-b" style={{borderColor:'var(--border)'}}>
          <span className="font-semibold text-sm" style={{color:'var(--text)'}}>{panelTitle[activeActivity]}</span>
          <button onClick={toggleSidebar} className="btn-ghost btn-sm">◁</button>
        </div>
        {activeActivity === 'knowledge' && <KnowledgePanel />}
        {activeActivity === 'scheduler' && <SchedulerPanel />}
        {activeActivity !== 'knowledge' && activeActivity !== 'scheduler' && (
          <div className="flex-1 flex items-center justify-center px-5 text-center text-xs leading-relaxed" style={{color:'var(--muted)'}}>
            {panelTitle[activeActivity]} 面板占位。详细控件将在后续任务中添加。
          </div>
        )}
      </div>
    );
  }

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: newSessionType }),
      });
      const data = await res.json();
      const listRes = await fetch('/api/sessions');
      const list = await listRes.json();
      useStore.getState().setSessions(list);
      useStore.setState({
        activeSessionId: data.id,
        messages: [],
        currentText: '',
        currentThinking: '',
        pendingThinking: '',
        activeToolIds: new Map(),
      });
      switchSession(data.id);
    } catch {
      useStore.getState().addSystemMsg('创建会话失败', 'error');
    }
    setCreating(false);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!confirm(`删除会话 ${id.slice(0, 10)}...?`)) return;
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      const listRes = await fetch('/api/sessions');
      const list = await listRes.json();
      // 延迟到事件循环结束后更新，避免 click 处理过程中触发重渲染导致状态不一致
      setTimeout(() => {
        useStore.getState().setSessions(list);
        if (activeSessionId === id) {
          useStore.setState({ activeSessionId: list[0]?.id ?? null });
        }
        useStore.getState().addSystemMsg(`会话已删除`, 'info');
      }, 0);
    } catch {
      setTimeout(() => {
        useStore.getState().addSystemMsg('删除会话失败', 'error');
      }, 0);
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
          useStore.getState().addSystemMsg(`从会话加载了 ${events.length} 条事件`, 'info');
        } else {
          useStore.setState({ messages: [], currentText: '', currentThinking: '', pendingThinking: '' });
          useStore.getState().addSystemMsg('空会话', 'info');
        }
      } else {
        useStore.setState({ messages: [], currentText: '', currentThinking: '', pendingThinking: '' });
      }
      // 2. 通知后端切换 session
      useStore.setState({ activeSessionId: id });
      switchSession(id);
    } catch {
      useStore.getState().addSystemMsg('加载会话历史失败', 'error');
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
  // 排序：webui 在前，tui 其次，feishu 最后，旧/未知 session 兜底展示
  const channelOrder = ['webui', 'tui', 'feishu', 'legacy', 'unknown'];
  const channels = [
    ...channelOrder.filter(ch => grouped[ch]?.length > 0),
    ...Object.keys(grouped).filter(ch => !channelOrder.includes(ch)),
  ];

  return (
    <div className="flex flex-col flex-shrink-0" style={{width: 250, background:'var(--surface)', borderRight:'1px solid var(--border)'}}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b" style={{borderColor:'var(--border)'}}>
        <span className="font-semibold text-sm" style={{color:'var(--text)'}}>会话</span>
        <button onClick={toggleSidebar} className="btn-ghost btn-sm">◁</button>
      </div>

      {/* New Session */}
      <div className="px-3 py-2 space-y-2">
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => setNewSessionType('normal')}
            disabled={creating}
            className={`btn-sm ${newSessionType === 'normal' ? 'btn btn-primary' : 'btn-ghost'}`}
          >
            普通
          </button>
          <button
            onClick={() => setNewSessionType('precise')}
            disabled={creating}
            className={`btn-sm ${newSessionType === 'precise' ? 'btn btn-primary' : 'btn-ghost'}`}
          >
            精确
          </button>
        </div>
        <button onClick={handleCreate} disabled={creating} className="btn btn-primary btn-sm w-full justify-center">
          {creating ? '⏳' : '+'} 新建会话
        </button>
      </div>

      {/* Channel sections */}
      <div className="flex-1 overflow-y-auto" style={{minHeight:0}}>
        {channels.length === 0 && (
          <div className="text-xs px-3 py-3" style={{color:'var(--muted)'}}>无会话</div>
        )}

        {channels.map(ch => {
          const meta = CHANNEL_META[ch] || { label: ch, icon: '📡' };
          const isCollapsed = collapsed[ch] || false;
          const chSessions = grouped[ch];
          return (
            <div key={ch}>
              {/* Channel header */}
              <div
                onClick={() => toggleChannel(ch)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors sticky top-0 z-10 cursor-pointer"
                style={{background:'var(--surface)', color:'var(--text-dim)', borderBottom:'1px solid var(--border)'}}
              >
                <span className="text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
                <span>{meta.icon}</span>
                <span>{meta.label}</span>
                <span className="ml-auto opacity-50">{chSessions.length}</span>
                {ch === 'legacy' && chSessions.length > 0 && (
                  <button
                    className="ml-2 px-1.5 py-0.5 text-[10px] rounded hover:opacity-80"
                    style={{ background: 'var(--danger)', color: '#fff' }}
                    onClick={async (e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      if (!confirm(`确定删除全部 ${chSessions.length} 个其他会话？`)) return;
                      try {
                        const res = await fetch('/api/sessions/channel/legacy', { method: 'DELETE' });
                        const data = await res.json();
                        const listRes = await fetch('/api/sessions');
                        const list = await listRes.json();
                        // 延迟到事件循环结束后更新，避免 click 处理过程中触发重渲染导致状态不一致
                        setTimeout(() => {
                          useStore.getState().setSessions(list);
                          useStore.getState().addSystemMsg(`已删除 ${data.deleted} 个会话`, 'info');
                        }, 0);
                      } catch {
                        setTimeout(() => {
                          useStore.getState().addSystemMsg('删除失败', 'error');
                        }, 0);
                      }
                    }}
                  >
                    清空
                  </button>
                )}
              </div>

              {/* Session list */}
              {!isCollapsed && chSessions.map(s => {
                const isActive = s.id === activeSessionId || s.id === useStore.getState().sessionId;
                return (
                  <div
                    key={s.id}
                    className="group flex items-center gap-2 px-2 pl-7 py-1.5 transition-colors text-xs"
                    style={{
                      background: isActive ? 'var(--accent)' : 'transparent',
                      color: isActive ? '#fff' : 'var(--text)',
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--surface-hover)'; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {/* 点击主体加载会话 */}
                    <div
                      onClick={() => !isActive && handleSelect(s.id)}
                      className="flex-1 flex items-center gap-2 cursor-pointer min-w-0"
                    >
                      <span className="truncate font-mono text-[11px]">{s.id.slice(0, 12)}...</span>
                      <span className="flex-shrink-0 text-[10px]" style={{color: isActive ? 'rgba(255,255,255,0.5)' : 'var(--muted)'}}>
                        {formatDate(s.createdAt)}
                      </span>
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {!isActive && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            handleSelect(s.id);
                          }}
                          className="rounded px-1.5 py-0.5 text-[10px] transition-colors hover:opacity-80"
                          style={{
                            background: isActive ? 'rgba(255,255,255,0.15)' : 'var(--surface)',
                            color: isActive ? '#fff' : 'var(--accent)',
                            border: '1px solid var(--border)',
                          }}
                          title="加载会话"
                        >
                          加载
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          handleDelete(s.id, e);
                        }}
                        className="rounded px-1.5 py-0.5 text-[10px] transition-colors hover:opacity-80"
                        style={{
                          background: isActive ? 'rgba(255,255,255,0.15)' : 'var(--surface)',
                          color: 'var(--danger)',
                          border: '1px solid var(--border)',
                        }}
                        title="删除会话"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t text-[11px]" style={{borderColor:'var(--border)', color:'var(--muted)'}}>
        {sessions.length} 会话 · {channels.length} 渠道
      </div>
    </div>
  );
}
