#!/usr/bin/env node
/**
 * 在（桌面壳的）页面里执行一段 JS，打印结果 —— CDP :9222（2026-10-16）
 *
 * 壳由 MainForm 带 `--remote-debugging-port=9222` 启动，故可直接进页面取证：
 * 读 `location.hash` / `localStorage`，或写入以构造对照场景。
 * 用法: node tools-dev/gui/cdp-eval.mjs "<js表达式>"      （表达式支持 await）
 */
const port = process.env.CDP_PORT || 9222;
const expr = process.argv[2];
if (!expr) {
  console.error('用法: node tools-dev/gui/cdp-eval.mjs "<js表达式>"');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page') || list[0];
if (!page) {
  console.error('  ❌ 找不到页面 target（壳没跑？或没带 --remote-debugging-port）');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const send = (method, params) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', () => j(new Error('CDP WS 连接失败')));
});

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
const out = r.result && r.result.result;
if (r.result && r.result.exceptionDetails) {
  console.log('  异常: ' + JSON.stringify(r.result.exceptionDetails.text || r.result.exceptionDetails));
} else {
  console.log('  ' + JSON.stringify(out ? out.value : r.result));
}

ws.close();
await new Promise((r2) => setTimeout(r2, 200));
