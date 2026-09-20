// tools-dev/ui-ctx-check.mjs —— 验证「上下文进度条**迭代级实时**」真的生效
//
// 为什么这么验（关键 ✓）：光看到"进度条会变"**证明不了任何事** ✗ ——
// 回合结束时 `state.update` 也会让它变 ⇒ 那是旧行为 ✓。
// 真正要证的是：**在回合还没结束（交付气泡还没出现）时，它就已经变过** ✓
// ⇒ 判据落在**时序**上：变更时刻 **必须早于** 交付气泡出现的时刻 ✓
//
// 做法（走真实用户路径 ✓）：真实输入框打字 → 真实发送键 → 高频轮询两个信号：
//   · `#header-context-text` 的文本
//   · `.msg-delivery`（交付气泡）是否已出现
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const PORT = 9343;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-ctx');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

/** 逼出"多轮迭代"的回合：先调工具、再交付 ⇒ context_update 至少发一次 ✓ */
const ASK = '请用 read 工具读一下 package.json 的 name 字段值，然后用 say 只回复这个值本身，不要多说。';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-ctx')}`,
  '--window-size=820,1180', 'about:blank',
], { stdio: 'ignore' });

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const l = await r.json();
      const p = l.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP 未就绪');
}
const ws = new WebSocket(await waitForCdp());
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.exception?.description || '').slice(0, 140));
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(method + ' → ' + JSON.stringify(m.error))) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description || '').slice(0, 160));
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}

const SAMPLE = `(() => ({
  ctx: (document.querySelector('#header-context-text') || {}).textContent || null,
  barW: (document.querySelector('#header-context-bar') || {}).style ? (document.querySelector('#header-context-bar').style.width || '') : '',
  delivery: document.querySelectorAll('.msg-delivery').length,
  busy: !!(document.querySelector('#chat-stop-btn') && !document.querySelector('#chat-stop-btn').classList.contains('hidden')),
}))()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(4000);
for (let i = 0; i < 30; i++) {
  const ok = await evaluate(`(document.querySelector('#header-online-text') || {}).textContent || ''`);
  if (ok && !/连接中|Connecting/.test(ok)) break;
  await sleep(500);
}
const base = await evaluate(SAMPLE);
console.log('  基线：上下文文本 = ' + base.ctx + '  进度条宽 = ' + (base.barW || '(空)'));

// —— 真实输入框 + 真实发送键 ——
await evaluate(`(() => {
  const i = document.querySelector('#chat-input');
  i.value = ${JSON.stringify(ASK)};
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await evaluate(`(() => { document.querySelector('#chat-send-btn').click(); })()`);
console.log('  已发送（逼出多轮迭代的回合 ✓）');

const samples = [];
let deliveryAt = null;
for (let i = 0; i < 240; i++) {           // 最多 60s（每 250ms 一次）
  await sleep(250);
  const s = await evaluate(SAMPLE);
  s.t = i * 250;
  samples.push(s);
  if (s.delivery > 0 && deliveryAt === null) { deliveryAt = s.t; break; }
}

// 首次"上下文文本发生变化"的时刻
const first = samples.find((s) => s.ctx && base.ctx && s.ctx !== base.ctx);
const changedAt = first ? first.t : null;
console.log('');
console.log('  采样数 = ' + samples.length + '；交付气泡出现于 t=' + (deliveryAt === null ? '未出现' : deliveryAt + 'ms'));
console.log('  上下文文本首次变化于 t=' + (changedAt === null ? '未变化' : changedAt + 'ms'));
if (first) console.log('  变化：' + base.ctx + '  →  ' + first.ctx);
await shot('1-after');

const results = [
  ['① 回合正常跑完（出现交付气泡）', deliveryAt !== null],
  ['② 上下文文本确实变过', changedAt !== null],
  ['③ **变在回合结束之前**（证明是迭代级实时，不只是回合边界跳 ✓）', changedAt !== null && deliveryAt !== null && changedAt < deliveryAt],
  ['④ 无控制台异常', errors.length === 0],
];
console.log('');
let pass = 0;
for (const [n, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++; }
console.log('Σ ' + pass + '/' + results.length);
if (errors.length) for (const e of errors.slice(0, 5)) console.log('  ✗ ' + e);
console.log('截图：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
process.exit(pass === results.length ? 0 : 1);
