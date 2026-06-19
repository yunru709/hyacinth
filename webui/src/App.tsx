import { useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './store';
import { ActivityRail } from './components/ActivityRail';
import { SessionsPanel } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatLog } from './components/ChatLog';
import { InputArea } from './components/InputArea';
import { InspectorDrawer } from './components/InspectorDrawer';
import { PermissionModal } from './components/PermissionModal';
import { CommandPalette } from './components/CommandPalette';
import { InitializationErrorCard } from './components/InitializationErrorCard';

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
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const closeInspector = useStore((s) => s.closeInspector);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncLayout = () => {
      const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      const state = useStore.getState();
      if (isMobile) {
        if (state.sidebarOpen) setSidebarOpen(false);
        if (state.inspectorOpen) closeInspector();
      }
    };
    syncLayout();
    window.addEventListener('resize', syncLayout);
    return () => window.removeEventListener('resize', syncLayout);
  }, [setSidebarOpen, closeInspector]);

  const bg = theme === 'dark' ? '#0b0f19' : '#f8fafc';

  return (
    <div className="flex h-screen overflow-hidden" style={{background: bg}}>
      <ActivityRail />
      <SessionsPanel switchSession={switchSession} />

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header sendMode={sendMode} />

        {/* Inline connection / initialization status */}
        {!connected && (
          <ConnectionStatusBar />
        )}
        {connected && !ready && !initError && (
          <InitializationIndicator />
        )}
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

        {/* Permission Modal */}
        <PermissionModal respondPermission={respondPermission} />

        {/* Command Palette */}
        <CommandPalette />
      </div>
      <InspectorDrawer
        switchProvider={switchProvider}
        switchModel={switchModel}
        queueRemove={queueRemove}
        queueClear={queueClear}
      />
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