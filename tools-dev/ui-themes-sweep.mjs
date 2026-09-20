// tools-dev/ui-themes-sweep.mjs —— 主题"批量巡检"：逐张点过去，验**每套都真的生效** ✓
//
// 判据（关键 ✓）：不只验"点得动"，还验"**换了样子**" ——
//   每次点击后比对 **`--hyacinth-background` 的计算值** 是否与上一套不同 ✓
//   （只看 data-theme 属性变了没意义 ✗：属性变了但调色板没覆盖，画面还是一样 ✗）
// 末尾**复原**成用户主题「夜园」并**刷新回读**（证明存住了 ✓）
// 逐套截图，便于肉眼复核 ✓（数字 ＋ 眼睛，两条腿走路 ✓）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const PORT = 9355;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-themes');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-sweep')}`,
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
const SNAP = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const cards = [...document.querySelectorAll('#theme-grid .theme-card')];
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    bg: cs.getPropertyValue('--hyacinth-background').trim(),
    fg: cs.getPropertyValue('--hyacinth-foreground').trim(),
    primary: cs.getPropertyValue('--hyacinth-primary').trim(),
    radius: cs.getPropertyValue('--radius-md').trim(),
    font: cs.getPropertyValue('--font-sans').trim().slice(0, 24),
    labels: cards.map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim().split(' ')[0]),
    pressed: cards.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => (c.innerText || '').trim().split(' ')[0]),
  };
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE + '#/settings' });
await sleep(4200);
await connected();
await evaluate(`location.hash = '#/settings'`);
await sleep(900);
await evaluate(`(() => { const l = document.querySelector('label[for="tab-appearance"]'); if (l) l.click(); })()`);
await sleep(1500);

const start = await evaluate(SNAP);
console.log('  卡片数 = ' + start.labels.length + '  → ' + start.labels.join(' / '));
console.log('');
const rows = [];
let prev = start;
let sameAsPrev = 0;

for (let i = 0; i < start.labels.length; i++) {
  const label = start.labels[i];
  const clicked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#theme-grid .theme-card')];
    const hit = cards.find((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return 'not-found';
    hit.click();
    return 'ok';
  })()`);
  await sleep(1200);
  const s = await evaluate(SNAP);
  const changed = s.bg !== prev.bg || s.primary !== prev.primary;
  if (!changed) sameAsPrev++;
  rows.push({ label, clicked, theme: s.theme, bg: s.bg, primary: s.primary, radius: s.radius, font: s.font, changed });
  console.log('  ' + String(i + 1).padStart(2) + '. ' + label.padEnd(6) + ' → id=' + String(s.theme).padEnd(10) +
    ' bg=' + String(s.bg).padEnd(9) + ' primary=' + String(s.primary).padEnd(9) +
    ' radius=' + String(s.radius).padEnd(6) + (changed ? '' : '  ⚠ 与上一套视觉相同'));
  await shot(String(i + 1).padStart(2, '0') + '-' + s.theme);
  prev = s;
}

// ── 复原成用户原主题「夜园」并刷新回读 ✓ ──
await evaluate(`(() => {
  const cards = [...document.querySelectorAll('#theme-grid .theme-card')];
  const hit = cards.find((c) => (c.innerText || '').includes('夜园'));
  if (hit) hit.click();
})()`);
await sleep(1800);
await send('Page.navigate', { url: BASE + '#/settings' });
await sleep(4200);
await connected();
const restored = await evaluate(SNAP);
console.log('');
console.log('  复原后（刷新回读）：theme=' + restored.theme + '  选中卡=' + JSON.stringify(restored.pressed));

const results = [
  ['① 卡片数 = 8（夜园 + 昼园 + 6 新）', start.labels.length === 8],
  ['② 每张卡都能点，且都真的换了样子（背景/主色变化 ✓）', sameAsPrev === 0 && rows.every((r) => r.clicked === 'ok')],
  ['③ 8 套 id 互不相同（没有重复定义 ✗）', new Set(rows.map((r) => r.theme)).size === rows.length],
  ['④ 风格差异体现在"设计语言"上（圆角/字体有变化 ✓）', new Set(rows.map((r) => r.radius + '|' + r.font)).size >= 3],
  ['⑤ 复原成功（刷新后回到 hyacinth ✓）', restored.theme === 'hyacinth'],
  ['⑥ 无控制台异常', errors.length === 0],
];
console.log('');
let pass = 0;
for (const [n, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++; }
console.log('Σ ' + pass + '/' + results.length);
if (errors.length) for (const e of errors.slice(0, 6)) console.log('  ✗ ' + e);
console.log('截图目录：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
process.exit(pass === results.length ? 0 : 1);
