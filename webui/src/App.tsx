import { useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './store';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatLog } from './components/ChatLog';
import { InputArea } from './components/InputArea';

export function App() {
  const { sendChat, sendStop, respondPermission, sendRollback, connected, ready } = useWebSocket();
  const permissionRequest = useStore((s) => s.permissionRequest);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!permissionRequest) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      switch (e.key.toLowerCase()) {
        case 'y': respondPermission('yes'); break;
        case 'a': respondPermission('always'); break;
        case 'n': respondPermission('no'); break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [permissionRequest, respondPermission]);

  const bg = theme === 'dark' ? '#0b0f19' : '#f8fafc';

  return (
    <div className="flex h-screen overflow-hidden" style={{background: bg}}>
      {/* Sidebar */}
      <Sidebar />

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <ChatLog sendRollback={sendRollback} />

        {/* Permission bar */}
        {permissionRequest && (
          <div className="mx-3 mb-1 p-3 rounded-lg flex items-center justify-between gap-3 text-sm"
               style={{background:'var(--surface)', border:'1px solid var(--warning)', color:'var(--text)'}}>
            <div className="min-w-0">
              <span className="font-bold text-xs" style={{color:'var(--warning)'}}>⚠ {permissionRequest.toolName}</span>
              <span className="ml-2 font-mono text-xs truncate" style={{color:'var(--text-dim)'}}>
                {JSON.stringify(permissionRequest.input).slice(0, 100)}
              </span>
            </div>
            <div className="flex gap-1.5 flex-shrink-0">
              {[{key:'Y', label:'Yes', cls:'var(--success)'}, {key:'A', label:'Always', cls:'var(--accent)'}, {key:'N', label:'No', cls:'var(--danger)'}].map(({key, label, cls}) => (
                <button key={key}
                  onClick={() => respondPermission(key.toLowerCase() as 'yes'|'always'|'no')}
                  className="btn btn-sm"
                  style={{borderColor: cls, color: cls}}
                >{label} ({key})</button>
              ))}
            </div>
          </div>
        )}

        <InputArea sendChat={sendChat} sendStop={sendStop} ready={ready} />

        {/* Overlays */}
        {(!connected || !ready) && (
          <div className="fixed inset-0 flex items-center justify-center z-50" style={{background:'rgba(0,0,0,0.5)'}}>
            <div className="text-center card px-8 py-6">
              <div className="text-3xl mb-3">{!connected ? '⚡' : '⏳'}</div>
              <div className="font-medium" style={{color:'var(--text)'}}>
                {!connected ? 'Connection lost' : 'Initializing agent...'}
              </div>
              <div className="text-sm mt-1" style={{color:'var(--muted)'}}>
                {!connected ? 'Reconnecting...' : 'Setting up your session'}
              </div>
              {connected && !ready && (
                <div className="mt-3 h-1 w-40 mx-auto rounded overflow-hidden" style={{background:'var(--border)'}}>
                  <div className="h-full rounded animate-pulse" style={{background:'var(--accent)', width:'60%'}} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
