import { useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './store';
import { ActivityRail } from './components/ActivityRail';
import { SessionsPanel } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatLog } from './components/ChatLog';
import { InputArea } from './components/InputArea';
import { PermissionModal } from './components/PermissionModal';
import { CommandPalette } from './components/CommandPalette';
import { InitializationErrorCard } from './components/InitializationErrorCard';
import { WorkflowPanel } from './components/WorkflowPanel';
import { ModelCenterPanel } from './components/ModelCenterPanel';
import { ContextPanel } from './components/ContextPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { KnowledgePanel } from './components/KnowledgePanel';
import { SchedulerPanel } from './components/SchedulerPanel';

const MOBILE_BREAKPOINT = 900;

export function App() {
  const {
    sendChat, sendStop, sendInsert, respondPermission,
    sendRollback, sendMode, switchSession,
    switchProvider, switchModel,
    queueMessage, queueInsert, queueRemove, queueClear,
    connected, ready,
  } = useWebSocket();
  const theme = useStore((s) => s.theme);
  const initError = useStore((s) => s.initError);
  const openPanel = useStore((s) => s.openPanel);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const activeActivity = useStore((s) => s.activeActivity);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncLayout = () => {
      const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      const state = useStore.getState();
      if (isMobile) {
        if (state.sidebarOpen) setSidebarOpen(false);
      }
    };
    syncLayout();
    window.addEventListener('resize', syncLayout);
    return () => window.removeEventListener('resize', syncLayout);
  }, [setSidebarOpen]);

  const bg = theme === 'dark' ? '#0b0f19' : '#f8fafc';

  /** 主内容区域：根据 ActivityRail 选择切换视图 */
  const renderMainContent = () => {
    // 聊天视图（默认）
    if (activeActivity === 'sessions' || activeActivity === 'model') {
      return (
        <>
          <Header sendMode={sendMode} />
          {!connected && <ConnectionStatusBar />}
          {connected && !ready && !initError && <InitializationIndicator />}
          {initError && (
            <InitializationErrorCard
              error={initError}
              onRetry={() => window.location.reload()}
              onOpenSettings={() => openPanel('settings')}
            />
          )}
          <ChatLog sendRollback={sendRollback} />
          <InputArea
            sendChat={sendChat}
            sendStop={sendStop}
            sendInsert={sendInsert}
            queueMessage={queueMessage}
            queueInsert={queueInsert}
            queueRemove={queueRemove}
            queueClear={queueClear}
            ready={ready}
            initError={initError}
          />
        </>
      );
    }

    // 功能面板视图
    switch (activeActivity) {
      case 'workflow':
        return <MainPanelView title="工作流" scrollable={false}><WorkflowPanel /></MainPanelView>;
      case 'knowledge':
        return <MainPanelView title="知识库"><KnowledgePanel /></MainPanelView>;
      case 'scheduler':
        return <MainPanelView title="调度"><SchedulerPanel /></MainPanelView>;
      case 'settings':
        return <MainPanelView title="设置"><SettingsPanel /></MainPanelView>;
      case 'context':
        return <MainPanelView title="上下文"><ContextPanel /></MainPanelView>;
      default:
        return null;
    }
  };

  return (
    <div className="flex h-screen overflow-hidden" style={{background: bg}}>
      <ActivityRail />
      <SessionsPanel switchSession={switchSession} />

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {renderMainContent()}
      </div>

      {/* Permission Modal */}
      <PermissionModal respondPermission={respondPermission} />

      {/* Command Palette */}
      <CommandPalette />
    </div>
  );
}

/** 功能面板的全屏主视图容器 */
function MainPanelView({ title, children, scrollable = true }: { title: string; children: React.ReactNode; scrollable?: boolean }) {
  const activeActivity = useStore((s) => s.activeActivity);
  const setActiveActivity = useStore((s) => s.setActiveActivity);

  return (
    <div className="flex flex-col h-full">
      {/* 面板标题栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0"
        style={{background:'var(--surface)', borderColor:'var(--border)'}}>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveActivity('sessions')}
            className="btn-ghost btn-sm"
            title="返回聊天"
            style={{fontSize: 14}}
          >
            ← 返回聊天
          </button>
          <span className="font-semibold text-sm" style={{color:'var(--text)'}}>{title}</span>
        </div>
        <div className="text-xs" style={{color:'var(--muted)'}}>
          {activeActivity}
        </div>
      </div>
      {/* 面板内容 */}
      <div className="flex-1 min-h-0" style={{
        overflowY: scrollable ? 'auto' : 'hidden',
        color: 'var(--text)',
        padding: scrollable ? '1rem' : '0',
      }}>
        {children}
      </div>
    </div>
  );
}

function ConnectionStatusBar() {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-2 text-xs border-b"
      style={{background:'var(--surface)', borderColor:'var(--border)', color:'var(--warning)'}}>
      <span className="w-2 h-2 rounded-full animate-pulse" style={{background:'var(--warning)'}} />
      连接断开，重新连接中…
    </div>
  );
}

function InitializationIndicator() {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-3 border-b"
      style={{background:'var(--surface)', borderColor:'var(--border)'}}>
      <div className="flex items-center gap-2 text-xs" style={{color:'var(--text-dim)'}}>
        <span className="w-2 h-2 rounded-full animate-pulse" style={{background:'var(--accent)'}} />
        正在初始化 Agent…
      </div>
      <div className="text-[11px]" style={{color:'var(--muted)'}}>首次连接可能需要几秒钟</div>
      <div className="mt-1 h-1 w-40 rounded overflow-hidden" style={{background:'var(--border)'}}>
        <div className="h-full rounded animate-pulse" style={{background:'var(--accent)', width:'60%'}} />
      </div>
    </div>
  );
}