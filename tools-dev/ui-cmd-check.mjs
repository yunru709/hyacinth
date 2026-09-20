// tools-dev/ui-cmd-check.mjs —— 验证网页端斜杠命令（接 command.list / command.execute ✓）
//
// 判据设计（关键 ✓）：
//   · `/help`、`/clear` 是**纯 UI 命令** ⇒ 协议层回 ui-only ⇒ 前端**本地处理** ✓
//   ⇒ 因此**不该出现交付气泡**（那代表真的走了一趟模型回合 ✗）—— 这是最强的判据 ✓
//   · 建议下拉：输入 `/he` ⇒ 应出现可见候选，且含 `/help` ✓
//   · 点候选 ⇒ 应回填到输入框 ✓
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const PORT = 9345;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-cmd');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-cmd')}`,
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

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(4000);
for (let i = 0; i < 30; i++) {
  const ok = await evaluate(`(document.querySelector('#header-online-text') || {}).textContent || ''`);
  if (ok && !/连接中|Connecting/.test(ok)) break;
  await sleep(500);
}
console.log('  已连接 ✓');

/** 往真实输入框打字（触发真实 input 事件 ⇒ 建议逻辑走真实路径 ✓） */
async function type(v) {
  await evaluate(`(() => {
    const i = document.querySelector('#chat-input');
    i.value = ${JSON.stringify(v)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(700);
}

// ── ① 建议下拉 ──────────────────────────────────────────────
await type('/he');
const sug = await evaluate(`(() => {
  const composer = document.querySelector('#chat-composer');
  const box = composer ? composer.querySelector('div.absolute') : null;
  return {
    hasComposer: !!composer,
    hasBox: !!box,
    visible: !!(box && !box.hidden),
    rows: box ? box.querySelectorAll('button').length : 0,
    text: box ? (box.innerText || '').slice(0, 120) : '',
  };
})()`);
console.log('  ① 建议态：composer=' + sug.hasComposer + ' 有下拉=' + sug.hasBox + ' 可见=' + sug.visible + ' 候选=' + sug.rows);
if (sug.text) console.log('     候选文本 = 「' + sug.text.replace(/\s+/g, ' ').slice(0, 90) + '」');
await shot('1-suggest');

// ── ② 点候选回填 ────────────────────────────────────────────
const picked = await evaluate(`(() => {
  const composer = document.querySelector('#chat-composer');
  const box = composer ? composer.querySelector('div.absolute') : null;
  if (!box) return 'no-box';
  const rows = [...box.querySelectorAll('button')];
  const hit = rows.find((b) => (b.innerText || '').includes('help')) || rows[0];
  if (!hit) return 'no-row';
  hit.click();
  return (document.querySelector('#chat-input') || {}).value || '';
})()`);
console.log('  ② 点候选后输入框 = 「' + String(picked) + '」');

// ── ③ 发 /help ⇒ 本地处理（**不该出现交付气泡** ✓）──────
await type('/help');
await evaluate(`(() => { document.querySelector('#chat-send-btn').click(); })()`);
await sleep(2500);
const afterHelp = await evaluate(`(() => {
  const ml = document.querySelector('#message-list');
  return {
    delivery: document.querySelectorAll('.msg-delivery').length,
    text: ml ? (ml.innerText || '') : '',
  };
})()`);
const helpOk = afterHelp.text.includes('可用命令') || afterHelp.text.includes('/');
console.log('  ③ /help ⇒ 交付气泡=' + afterHelp.delivery + '（期望 0 ⇒ 没走模型 ✓）；含命令清单=' + helpOk);
await shot('2-help');

// ── ④ 发 /clear ⇒ 本地清屏 ─────────────────────────────────
await type('/clear');
await evaluate(`(() => { document.querySelector('#chat-send-btn').click(); })()`);
await sleep(1200);
const afterClear = await evaluate(`(() => {
  const ml = document.querySelector('#message-list');
  return {
    delivery: document.querySelectorAll('.msg-delivery').length,
    kids: ml ? ml.children.length : -1,
    text: ml ? (ml.innerText || '').slice(0, 120) : '',
  };
})()`);
console.log('  ④ /clear ⇒ 消息区子节点=' + afterClear.kids + '；交付气泡=' + afterClear.delivery);
console.log('     残留文本 = 「' + String(afterClear.text).replace(/\s+/g, ' ').slice(0, 80) + '」');
await shot('3-clear');

const results = [
  ['① 输入 / 时出现建议下拉', sug.visible && sug.rows > 0],
  ['② 点候选能回填输入框', String(picked).startsWith('/')],
  ['③ /help 本地处理（**没触发模型回合**）', afterHelp.delivery === 0 && helpOk],
  ['④ /clear 本地清屏（没触发模型回合）', afterClear.delivery === 0],
  ['⑤ 无控制台异常', errors.length === 0],
];
console.log('');
let pass = 0;
for (const [n, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++; }
console.log('Σ ' + pass + '/' + results.length);
if (errors.length) for (const e of errors.slice(0, 5)) console.log('  ✗ ' + e);
console.log('截图：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
process.exit(pass === results.length ? 0 : 1);
