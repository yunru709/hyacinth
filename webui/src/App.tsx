import { useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './store';
import { Header } from './components/Header';
import { ChatLog } from './components/ChatLog';
import { InputArea } from './components/InputArea';

export function App() {
  const { sendChat, sendStop, respondPermission, connected, ready } = useWebSocket();
  const permissionRequest = useStore((s) => s.permissionRequest);

  // 键盘快捷键：Y / A / N 响应权限请求
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!permissionRequest) return;

      // 如果焦点在 input 中，不处理（除非是专门的权限键）
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      switch (e.key.toLowerCase()) {
        case 'y':
          respondPermission('yes');
          break;
        case 'a':
          respondPermission('always');
          break;
        case 'n':
          respondPermission('no');
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [permissionRequest, respondPermission]);

  return (
    <div className="flex flex-col h-screen bg-bg">
      <Header />

      <ChatLog />

      {/* Permission modal overlay */}
      {permissionRequest && (
        <div className="mx-4 mb-2 p-3 border border-yellow-500/30 bg-yellow-500/10 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-yellow-400 text-sm font-bold">
                ⚠ {permissionRequest.toolName}
              </span>
              <span className="text-yellow-300/70 text-xs ml-2 font-mono">
                {JSON.stringify(permissionRequest.input).slice(0, 120)}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => respondPermission('yes')}
                className="px-3 py-1 bg-green-500/15 text-green-400 rounded text-xs font-medium hover:bg-green-500/25 transition-colors"
              >
                Yes (Y)
              </button>
              <button
                onClick={() => respondPermission('always')}
                className="px-3 py-1 bg-blue-500/15 text-blue-400 rounded text-xs font-medium hover:bg-blue-500/25 transition-colors"
              >
                Always (A)
              </button>
              <button
                onClick={() => respondPermission('no')}
                className="px-3 py-1 bg-red-500/15 text-red-400 rounded text-xs font-medium hover:bg-red-500/25 transition-colors"
              >
                No (N)
              </button>
            </div>
          </div>
        </div>
      )}

      <InputArea sendChat={sendChat} sendStop={sendStop} ready={ready} />

      {/* Overlay: not connected → reconnecting; connected but not ready → initializing */}
      {(!connected || !ready) && (
        <div className="fixed inset-0 bg-bg/80 flex items-center justify-center z-50">
          <div className="text-center">
            <div className="text-2xl mb-2">{!connected ? '⚡' : '⏳'}</div>
            <div className="text-muted">
              {!connected ? 'Connection lost. Reconnecting...' : 'Initializing agent session...'}
            </div>
            {connected && !ready && (
              <div className="mt-3 w-48 mx-auto h-1 bg-border rounded overflow-hidden">
                <div className="h-full bg-accent animate-pulse rounded" style={{width: '60%'}} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
