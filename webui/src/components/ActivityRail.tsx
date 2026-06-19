import { useStore } from '../store';
import type { ActivityView, PanelView } from '../types';

const ITEMS: Array<{ id: ActivityView; label: string; icon: string; panel?: PanelView }> = [
  { id: 'sessions', label: '会话', icon: '◉' },
  { id: 'model', label: '模型', icon: '▣', panel: 'models' },
  { id: 'context', label: '上下文', icon: '▥', panel: 'context' },
  { id: 'knowledge', label: '知识库', icon: '▤', panel: 'knowledge' },
  { id: 'scheduler', label: '调度', icon: '◷', panel: 'scheduler' },
  { id: 'settings', label: '设置', icon: '⚙', panel: 'settings' },
];

export function ActivityRail() {
  const activeActivity = useStore(s => s.activeActivity);
  const setActiveActivity = useStore(s => s.setActiveActivity);
  const openPanel = useStore(s => s.openPanel);
  const theme = useStore(s => s.theme);
  const toggleTheme = useStore(s => s.toggleTheme);

  return (
    <div className="flex flex-col items-center py-3 gap-2 border-r flex-shrink-0" style={{width: 52, borderColor:'var(--border)', background:'var(--surface)'}}>
      <div className="font-bold text-sm mb-1" style={{color:'var(--accent)'}}>D</div>
      {ITEMS.map(item => {
        const active = activeActivity === item.id;
        return (
          <button
            key={item.id}
            onClick={() => {
              setActiveActivity(item.id);
              if (item.panel) openPanel(item.panel);
            }}
            className="w-9 h-9 rounded-lg text-sm transition-colors"
            style={{
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--text-dim)',
              border: active ? '1px solid var(--accent)' : '1px solid transparent',
            }}
            title={item.label}
            aria-label={item.label}
          >
            {item.icon}
          </button>
        );
      })}
      <div className="flex-1" />
      <button onClick={toggleTheme} className="btn-ghost btn-sm" title="切换主题">{theme === 'dark' ? '☀' : '☾'}</button>
    </div>
  );
}
