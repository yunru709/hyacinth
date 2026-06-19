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

export function App() {
  const { sendChat, sendStop, sendInsert, respondPermission, sendRollback, sendMode, switchSession, connected, ready } = useWebSocket();
  const theme = useStore((s) => s.theme);

  const bg = theme === 'dark' ? '#0b0f19' : '#f8fafc';

  return (
    <div className="flex h-screen overflow-hidden" style={{background: bg}}>
      <ActivityRail />
      <SessionsPanel switchSession={switchSession} />

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header sendMode={sendMode} />
        <ChatLog sendRollback={sendRollback} />

        <InputArea sendChat={sendChat} sendStop={sendStop} sendInsert={sendInsert} ready={ready} />

        {/* Overlays */}
        {(!connected || !ready) && (
          <div className="fixed inset-0 flex items-center justify-center z-50" style={{background:'rgba(0,0,0,0.5)'}}>
            <div className="text-center card px-8 py-6">
              <div className="text-3xl mb-3">{!connected ? '⚡' : '⏳'}</div>
              <div className="font-medium" style={{color:'var(--text)'}}>
                {!connected ? '连接断开' : '初始化 Agent...'}
              </div>
              <div className="text-sm mt-1" style={{color:'var(--muted)'}}>
                {!connected ? '重新连接中...' : '正在设置会话'}
              </div>
              {connected && !ready && (
                <div className="mt-3 h-1 w-40 mx-auto rounded overflow-hidden" style={{background:'var(--border)'}}>
                  <div className="h-full rounded animate-pulse" style={{background:'var(--accent)', width:'60%'}} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Permission Modal */}
        <PermissionModal respondPermission={respondPermission} />

        {/* Command Palette */}
        <CommandPalette />
      </div>
      <InspectorDrawer />
    </div>
  );
}