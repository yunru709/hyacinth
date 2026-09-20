// tools-dev/ui-theme-check.mjs —— 主题切换的**端到端**验证（含刷新后回读 ✓）
//
// 用户报（2026-09-20）：「点其它主题 ⇒ 画面切上去、又退回，像被覆盖了配置」✓ —— 判断正确 ✓
// 根因：`ConfigManager.save()` 两步顺序反了 ⇒ 先写 ui 段、紧接着被不含 ui 的快照整体覆盖 ✗
//
// 判据（关键 ✓）：**刷新之后**主题仍是刚点的那个 —— 那才证明"存住了" ✓
//   （只看点完那一瞬没意义 ✗：前端本来就会立刻本地应用 ✓）
// 顺带**复原**：测完把主题点回「夜园」(hyacinth) ✓（别把用户主题留在别处 ✗）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const PORT = 9353;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-theme');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const TARGET = '昼园';   // 目标主题（对应 id 'light' ✓）
const BACK = '夜园';     // 用户原主题（对应 id 'hyacinth' ✓）

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-theme')}`,
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
async function connected() {
  for (let i = 0; i < 40; i++) {
    const t = await evaluate(`(document.querySelector('#header-online-text') || {}).textContent || ''`);
    if (t && !/连接中|Connecting/.test(t)) return true;
    await sleep(300);
  }
  return false;
}
/** 当前生效主题（html[data-theme] ✓）＋ 卡片选中态（aria-pressed ✓） */
const STATE = `(() => {
  const cards = [...document.querySelectorAll('#theme-grid .theme-card')];
  const pressed = cards.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 10));
  return { theme: document.documentElement.getAttribute('data-theme'), pressed, count: cards.length };
})()`;

async function gotoAppearance() {
  await evaluate(`location.hash = '#/settings'`);
  await sleep(900);
  await evaluate(`(() => { const l = document.querySelector('label[for="tab-appearance"]'); if (l) l.click(); })()`);
  await sleep(1200);
}
async function clickTheme(label) {
  return evaluate(`(() => {
    const cards = [...document.querySelectorAll('#theme-grid .theme-card')];
    const hit = cards.find((c) => (c.innerText || '').includes(${JSON.stringify(label)}));
    if (!hit) return 'not-found';
    hit.click();
    return 'clicked';
  })()`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE + '#/settings' });
await sleep(4000);
await connected();
await gotoAppearance();

const before = await evaluate(STATE);
console.log('  ① 初始：data-theme=' + before.theme + '  选中卡=' + JSON.stringify(before.pressed) + '  卡数=' + before.count);
await shot('1-before');

const c1 = await clickTheme(TARGET);
await sleep(2500);
const afterClick = await evaluate(STATE);
console.log('  ② 点「' + TARGET + '」(' + c1 + ')：data-theme=' + afterClick.theme + '  选中卡=' + JSON.stringify(afterClick.pressed));
await shot('2-after-click');

// ── 关键：刷新后是否还是它 ✓ ──
await send('Page.navigate', { url: BASE + '#/settings' });
await sleep(4500);
await connected();
const afterReload = await evaluate(STATE);
console.log('  ③ **刷新后**：data-theme=' + afterReload.theme + '  选中卡=' + JSON.stringify(afterReload.pressed));
await shot('3-after-reload');

// ── 复原成用户原主题 ✓ ──
await gotoAppearance();
const c2 = await clickTheme(BACK);
await sleep(2500);
await send('Page.navigate', { url: BASE + '#/settings' });
await sleep(4500);
await connected();
const restored = await evaluate(STATE);
console.log('  ④ 复原点「' + BACK + '」(' + c2 + ') 并刷新后：data-theme=' + restored.theme + '  选中卡=' + JSON.stringify(restored.pressed));
await shot('4-restored');

const results = [
  ['① 能进外观页且卡片渲染出来', before.count >= 5],
  ['② 点击后立即生效（本地应用）', afterClick.theme && afterClick.theme !== before.theme],
  ['③ **刷新后主题仍是刚点的那个** ✓（核心判据：证明真的存住了）', afterReload.theme === afterClick.theme],
  ['④ 复原成功（刷新后回到用户原主题）', restored.theme === before.theme],
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
