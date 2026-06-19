import { useStore } from '../store';
import { ModelCenterPanel } from './ModelCenterPanel';
import { ContextPanel } from './ContextPanel';
import { SettingsPanel } from './SettingsPanel';
import { KnowledgePanel } from './KnowledgePanel';
import { SchedulerPanel } from './SchedulerPanel';

const TITLES: Record<string, string> = {
  status: '连接状态',
  model: '模型中心',
  mode: '模式详情',
  context: '上下文详情',
  settings: '设置',
  models: '模型中心',
  knowledge: '知识库',
  scheduler: '调度',
  commands: '命令面板',
};

interface InspectorDrawerProps {
  switchProvider: (provider: string) => void;
  switchModel: (model: string) => void;
  queueRemove: (id: string) => void;
  queueClear: () => void;
}

export function InspectorDrawer({ switchProvider, switchModel, queueRemove, queueClear }: InspectorDrawerProps) {
  const inspectorOpen = useStore(s => s.inspectorOpen);
  const inspectorView = useStore(s => s.inspectorView);
  const activePanel = useStore(s => s.activePanel);
  const closeInspector = useStore(s => s.closeInspector);
  const connected = useStore(s => s.connected);
  const ready = useStore(s => s.ready);
  const mode = useStore(s => s.mode);
  const config = useStore(s => s.config);
  const tokensUsed = useStore(s => s.tokensUsed);
  const maxTokens = useStore(s => s.maxTokens);
  const toast = useStore(s => s.toast);
  const setCommandPaletteOpen = useStore(s => s.setCommandPaletteOpen);

  if (!inspectorOpen) return null;

  const title = activePanel ? (TITLES[activePanel] || activePanel) : (TITLES[inspectorView] ?? inspectorView);

  return (
    <>
      <div className="mobile-overlay hidden max-lg:block" onClick={closeInspector} aria-hidden="true" />
      <aside className="inspector-drawer flex flex-col flex-shrink-0 border-l" style={{width: 300, background:'var(--surface)', borderColor:'var(--border)'}}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{borderColor:'var(--border)'}}>
        <div>
          <div className="font-semibold text-sm" style={{color:'var(--text)'}}>{title}</div>
          <div className="text-[11px] mt-0.5" style={{color:'var(--muted)'}}>{activePanel ? '面板' : '抽屉容器'}</div>
        </div>
        <button onClick={closeInspector} className="btn-ghost btn-sm" title="关闭">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4" style={{color:'var(--text)'}}>
        {/* Toast feedback */}
        {toast && (
          <div className="mb-3 px-3 py-2 rounded-md text-xs font-medium"
               style={{background: toast.type === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                       color: toast.type === 'success' ? 'var(--success)' : 'var(--danger)',
                       border: `1px solid ${toast.type === 'success' ? 'var(--success)' : 'var(--danger)'}`}}>
            {toast.message}
          </div>
        )}

        {/* Render panel based on activePanel */}
        {activePanel === 'context' && <ContextPanel />}
        {activePanel === 'settings' && <SettingsPanel />}
        {activePanel === 'models' && <ModelCenterPanel switchProvider={switchProvider} switchModel={switchModel} />}
        {activePanel === 'knowledge' && <KnowledgePanel />}
        {activePanel === 'scheduler' && <SchedulerPanel />}
        {activePanel === 'commands' && (
          <div className="space-y-3 text-sm">
            <div className="card p-3 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>命令面板</div>
              <div className="text-xs" style={{color:'var(--text-dim)'}}>
                使用键盘快捷键打开命令面板，快速访问所有功能。
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="px-1.5 py-0.5 rounded border" style={{borderColor:'var(--border)', background:'var(--bg)'}}>Ctrl</span>
                <span>+</span>
                <span className="px-1.5 py-0.5 rounded border" style={{borderColor:'var(--border)', background:'var(--bg)'}}>K</span>
              </div>
              <button
                onClick={() => setCommandPaletteOpen(true)}
                className="btn btn-primary btn-sm w-full justify-center"
              >
                打开命令面板
              </button>
            </div>
          </div>
        )}

        {/* Fallback: legacy inspector views */}
        {!activePanel && (
          <>
            {inspectorView === 'model' ? (
              <ModelCenterPanel switchProvider={switchProvider} switchModel={switchModel} />
            ) : (
              <div className="space-y-3 text-sm">
                <div className="card p-3 space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide" style={{color:'var(--muted)'}}>当前状态</div>
                  {inspectorView === 'status' && (
                    <>
                      <div className="flex justify-between gap-3"><span style={{color:'var(--muted)'}}>WebSocket</span><span>{connected ? '已连接' : '已断开'}</span></div>
                      <div className="flex justify-between gap-3"><span style={{color:'var(--muted)'}}>Agent</span><span>{ready ? '就绪' : '初始化中'}</span></div>
                    </>
                  )}
                  {inspectorView === 'mode' && (
                    <div className="flex justify-between gap-3"><span style={{color:'var(--muted)'}}>模式</span><span className="capitalize">{mode === 'precise' ? '精确' : '普通'}</span></div>
                  )}
                  {inspectorView === 'context' && (
                    <>
                      <div className="flex justify-between gap-3"><span style={{color:'var(--muted)'}}>Token</span><span>{tokensUsed.toLocaleString()}</span></div>
                      <div className="flex justify-between gap-3"><span style={{color:'var(--muted)'}}>上限</span><span>{maxTokens.toLocaleString()}</span></div>
                    </>
                  )}
                </div>

                <div className="flex items-center justify-center min-h-40 rounded-lg border border-dashed px-5 text-center text-xs leading-relaxed" style={{borderColor:'var(--border)', color:'var(--muted)'}}>
                  Inspector 详情内容预留给后续任务，当前为空占位。
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
    </>
  );
}
