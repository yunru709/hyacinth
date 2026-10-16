#!/usr/bin/env node
/**
 * 查「新会话被判成陪伴进行中」的真因（2026-10-16）
 * 对运行实例依次问：companion.get / state.get / meta 通道信息。
 */
const port = (() => { const i = process.argv.indexOf('--port'); return i >= 0 ? process.argv[i + 1] : '3130'; })();

const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`);
let seq = 0;
const pending = new Map();
const events = [];

function call(method, params) {
  const id = `p${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ kind: 'request', id, method, params: params ?? {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); } }, 6000);
  });
}

ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.kind === 'response') { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m.result ?? { __err: m.error }); } return; }
  if (m.kind === 'event') events.push({ type: m.type, payload: m.payload });
});

ws.addEventListener('open', async () => {
  await new Promise((r) => setTimeout(r, 800));   // 等 ui.connected
  console.log('=== meta/通道 ===');
  console.log('  meta.get domains 数 = ' + ((await call('meta.get')).domains || []).length);
  console.log('=== companion.get（决定前端是否显示"陪伴会话进行中"）===');
  console.log('  ' + JSON.stringify(await call('companion.get')));
  console.log('=== state.get（本会话模式）===');
  const st = await call('state.get');
  console.log('  sessionId=' + st.sessionId + '  mode=' + st.mode + '  routeMode=' + st.routeMode + '  model=' + st.model + '/' + st.provider);
  console.log('=== 版本 ===');
  console.log('  ' + JSON.stringify((await call('plugin.list'))).slice(0, 160));
  console.log('=== 收到的事件 ===');
  console.log('  ' + events.map((e) => e.type).join(', '));
  ws.close();
  process.exit(0);
});
ws.addEventListener('error', (e) => { console.error('WS error: ' + (e.message || e.type)); process.exit(1); });
setTimeout(() => { console.error('超时'); process.exit(2); }, 20000);
