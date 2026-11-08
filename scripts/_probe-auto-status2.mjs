// 直连后端 UI 协议查 auto.status 真实值（须等 ui.connected 事件后再发请求）
import WebSocket from 'ws';

const url = 'ws://127.0.0.1:3130/ui';
const ws = new WebSocket(url);
let seq = 0;
const pending = new Map();
let connected = false;

function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'r' + (++seq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 6000);
  });
}

ws.on('message', async (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.kind === 'response') {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg.result) : p.reject(msg.error || new Error('err')); }
    return;
  }
  if (msg.kind === 'event' && msg.type === 'ui.connected') {
    connected = true;
    console.log('[1] 收到 ui.connected，可以发请求');
    try {
      const r = await req('auto.status', {});
      console.log('[2] auto.status =', JSON.stringify(r, null, 2));
    } catch (e) { console.error('[2] auto.status 失败:', e.message); }
    try {
      const m = await req('message.history', {});
      console.log('[3] message.history 可用（会话就绪）:', Array.isArray(m) ? m.length : typeof m);
    } catch (e) { console.log('[3] history 不可用:', e.message); }
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => { console.error('WS 错误:', e.message); process.exit(1); });
setTimeout(() => {
  console.error('超时，connected =', connected);
  process.exit(2);
}, 12000);
