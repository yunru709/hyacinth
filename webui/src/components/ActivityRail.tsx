import type { ReactNode } from 'react';
import { useStore } from '../store';
import type { ActivityView, PanelView } from '../types';

const ITEMS: Array<{ id: ActivityView; label: string; shortLabel: string; panel?: PanelView }> = [
  { id: 'sessions', label: '会话', shortLabel: '会话' },
  { id: 'model', label: '模型', shortLabel: '模型', panel: 'models' },
  { id: 'context', label: '上下文', shortLabel: '上下', panel: 'context' },
  { id: 'workflow', label: '工作流', shortLabel: '工作流', panel: 'workflow' },
  { id: 'knowledge', label: '知识库', shortLabel: '知识', panel: 'knowledge' },
  { id: 'scheduler', label: '调度', shortLabel: '调度', panel: 'scheduler' },
  { id: 'settings', label: '设置', shortLabel: '设置', panel: 'settings' },
];

const ICONS: Record<ActivityView, ReactNode> = {
  sessions: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  model: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 6V3M15 6V3M9 18v3M15 18v3M18 9h3M18 15h3M3 9h3M3 15h3" />
    </svg>
  ),
  context: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 12 12 17 22 12" />
      <polyline points="2 17 12 22 22 17" />
    </svg>
  ),
  workflow: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="6" height="6" rx="1" />
      <rect x="16" y="3" width="6" height="6" rx="1" />
      <rect x="9" y="15" width="6" height="6" rx="1" />
      <path d="M5 9v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
      <path d="M12 14v1" />
    </svg>
  ),
  knowledge: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  scheduler: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

export function ActivityRail() {
  const activeActivity = useStore(s => s.activeActivity);
  const setActiveActivity = useStore(s => s.setActiveActivity);
  const openPanel = useStore(s => s.openPanel);
  const closeInspector = useStore(s => s.closeInspector);
  const theme = useStore(s => s.theme);
  const toggleTheme = useStore(s => s.toggleTheme);

  return (
    <div className="flex flex-col items-center py-3 gap-2 border-r flex-shrink-0" style={{ width: 52, borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <div className="font-bold text-sm mb-1" style={{ color: 'var(--accent)' }}>D</div>
      {ITEMS.map(item => {
        const active = activeActivity === item.id;
        return (
          <button
            key={item.id}
            onClick={() => {
              setActiveActivity(item.id);
              if (item.panel) {
                openPanel(item.panel);
              } else if (item.id === 'sessions') {
                closeInspector();
              }
            }}
            className="w-10 h-11 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            style={{
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--text-dim)',
              border: active ? '1px solid var(--accent)' : '1px solid transparent',
            }}
            title={item.label}
            aria-label={item.label}
            aria-pressed={active}
          >
            {ICONS[item.id]}
            <span className="text-[9px] leading-none truncate max-w-full px-0.5">{item.shortLabel}</span>
          </button>
        );
      })}
      <div className="flex-1" />
      <button onClick={toggleTheme} className="btn-ghost btn-sm" title="切换主题" aria-label="切换主题">{theme === 'dark' ? '☀' : '☾'}</button>
    </div>
  );
}
