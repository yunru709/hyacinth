#!/usr/bin/env node
/**
 * e2e：陪伴模式能否真的进入（2026-10-16）
 *
 * 修复前：柔柔/meta.json 的 type="normal" ⇒ 跨模式闸门拒绝 ⇒ companion.activate 必失败
 *         （「该会话属于「normal」模式，当前是「companion」模式」）。
 * 修复后：getOrCreate 自愈 meta ⇒ activate 应成功。
 *
 * 用法: node tools-dev/gui/probe-companion-activate.mjs [--port 3131] [--character 柔柔]
 */
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const port = arg('port', '3131');
const character = arg('character', '柔柔');

const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`);
const pending = new Map();
let seq = 0;
let handshake = false;

const send = (method, params) => new Promise((res) => {
  const id = 'q' + (++seq);
  pending.set(id, res);
  ws.send(JSON.stringify({ kind: 'request', id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: method + ' 超时' } }); } }, 15000);
});

ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.kind === 'event' && m.type === 'ui.connected') handshake = true;
  if (m.kind === 'response' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
});

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('连接/握手超时')), 15000);
  ws.addEventListener('open', () => { const iv = setInterval(() => { if (handshake) { clearInterval(iv); clearTimeout(t); res(); } }, 100); });
  ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('WS error')); });
});

console.log(`=== 1) 进入前 companion.get ===`);
const before = await send('companion.get');
console.log('  ' + JSON.stringify(before.result || before.error));

console.log(`=== 2) companion.activate { character: "${character}" } ===`);
const act = await send('companion.activate', { character });
const ok = !!(act.result && act.result.active);
console.log('  ' + JSON.stringify(act.result || act.error));

console.log('=== 3) 进入后 companion.get ===');
const after = await send('companion.get');
console.log('  ' + JSON.stringify(after.result || after.error));

console.log('');
console.log('=== 结论 ===');
if (ok) {
  console.log(`  ✅ companion.activate 成功（角色 ${(act.result && act.result.character) || character}）`);
} else {
  console.log('  ❌ companion.activate 失败 —— 进陪伴这条链仍走不通');
}

ws.close();
await new Promise((r) => setTimeout(r, 200));
process.exit(ok ? 0 : 1);
