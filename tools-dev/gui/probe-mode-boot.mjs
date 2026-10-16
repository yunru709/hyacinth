#!/usr/bin/env node
/**
 * 只问后端：启动默认模式 vs 实际模式（2026-10-16）
 *
 * 事故：companion 插件在激活时无条件进陪伴 ⇒ config.startup.defaultMode=normal
 * 也被覆盖，全新后端开机 companion.get 即 active:true。
 * 修后应随会话类型走：normal 配置 ⇒ active:false；companion 配置 ⇒ active:true。
 *
 * 用法: node tools-dev/gui/probe-mode-boot.mjs --port 3131
 */
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const port = arg('port', '3131');

const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`);
const pending = new Map();
let seq = 0;
let handshake = false;

const send = (method, params) => new Promise((res) => {
  const id = 'q' + (++seq);
  pending.set(id, res);
  ws.send(JSON.stringify({ kind: 'request', id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: method + ' 超时' } }); } }, 12000);
});

ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.kind === 'event' && m.type === 'ui.connected') handshake = true;
  if (m.kind === 'response' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
});

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('连接/握手超时')), 12000);
  ws.addEventListener('open', () => { const iv = setInterval(() => { if (handshake) { clearInterval(iv); clearTimeout(t); res(); } }, 100); });
  ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('WS error')); });
});

const cfg = await send('config.get', { path: 'startup.defaultMode' });
const cmp = await send('companion.get');
const configured = cfg.result ? cfg.result.value : '(读取失败)';
const active = cmp.result ? cmp.result.active : '(读取失败)';
const character = cmp.result ? cmp.result.character : '';

console.log(`  startup.defaultMode = ${JSON.stringify(configured)}`);
console.log(`  companion.get       = ${JSON.stringify(cmp.result || cmp.error)}`);
console.log(`  ⇒ 配置=${configured} / 实际 active=${active}${character ? ' (' + character + ')' : ''}`);

// 判据：两者应当一致（配置说 normal 就不该 active）
const ok = (configured === 'companion') === (active === true);
console.log(ok ? '  ✅ 配置与实际模式一致' : '  ❌ 配置被覆盖（配置与实际模式不一致）');

ws.close();
await new Promise((r) => setTimeout(r, 200));
process.exit(ok ? 0 : 1);
