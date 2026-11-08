// 直连后端 UI 协议，查 auto.status 的真实返回值
import WebSocket from 'ws';

const url = 'ws://127.0.0.1:3130/ui';
console.log('[1] 连接', url);
const ws = new WebSocket(url);

let seq = 0;
const pending = new Map();

function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'r' + (++seq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 8000);
  });
}

ws.on('open', async () => {
  console.log('[2] WS 已连接');
  try {
    const r = await req('auto.status', {});
    console.log('[3] auto.status 原始返回:');
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('[3] auto.status 失败:', e.message);
  }
  // 顺便查一下后端与会话
  try {
    const s = await req('session.current', {});
    console.log('[4] session.current:', JSON.stringify(s));
  } catch (e) { console.log('[4] session.current 不可用:', e.message); }
  ws.close();
  process.exit(0);
});

ws.on('error', (e) => { console.error('WS 错误:', e.message); process.exit(1); });
setTimeout(() => { console.error('整体超时'); process.exit(2); }, 15000);
