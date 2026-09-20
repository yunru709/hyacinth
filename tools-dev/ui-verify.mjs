// ui-verify.mjs —— 验证响应式抽屉：三个视口 + 开合交互 + 计算样式取证
// 与 ui-drive.mjs 的区别：这个**断言行不行**（拿 computed style 说话），不只是截图 ✓
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CHROME } from './_chrome.mjs';
const PORT = 9334;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-verify');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });
const PROFILE = path.join(process.env.TEMP || '.', 'chrome-verify-profile');
const errors = [];

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const p = list.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP 端点未就绪');
}

const ws = new WebSocket(await waitForCdp());
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + String(m.params.exceptionDetails?.exception?.description || '').slice(0, 160));
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(method + ' → ' + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description || '').slice(0, 200));
  return r.result?.value;
}
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 900 });
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}
/** 取侧栏与菜单键的实测样式 + 抽屉类状态 */
async function probe() {
  return evaluate(`(() => {
    const aside = document.querySelector('#app-shell > .body-area > aside');
    const btn = document.querySelector('#nav-drawer-btn');
    const bd = document.querySelector('#nav-backdrop');
    const main = document.querySelector('#hyacinth-main');
    const cs = aside ? getComputedStyle(aside) : null;
    const bs = btn ? getComputedStyle(btn) : null;
    const ds = bd ? getComputedStyle(bd) : null;
    return {
      asideRect: aside ? { x: Math.round(aside.getBoundingClientRect().x), w: Math.round(aside.getBoundingClientRect().width) } : null,
      asideTransform: cs ? cs.transform : null,
      asideDisplay: cs ? cs.display : null,
      asidePosition: cs ? cs.position : null,
      btnDisplay: bs ? bs.display : null,
      backdropDisplay: ds ? ds.display : null,
      backdropPosition: ds ? ds.position : null,
      mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
      navOpen: !!document.querySelector('#app-shell.nav-open'),
      vw: window.innerWidth,
    };
  })()`);
}
function row(label, p) {
  console.log('  ' + label);
  console.log('    viewport=' + p.vw + '  侧栏 x=' + (p.asideRect ? p.asideRect.x : '?') + ' 宽=' + (p.asideRect ? p.asideRect.w : '?') +
    '  transform=' + p.asideTransform + '  display=' + p.asideDisplay + '  position=' + p.asidePosition);
  console.log('    菜单键 display=' + p.btnDisplay + '  遮罩 display=' + p.backdropDisplay + '  主区宽=' + p.mainW + '  nav-open=' + p.navOpen);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(3800);

const results = [];

// ── A. 桌面：侧栏常驻、菜单键隐藏 ──
await viewport(1440, 900); await sleep(900);
let p = await probe(); row('【A】桌面 1440×900（期望：侧栏在 x≈0、菜单键 display:none）', p);
await shot('A-desktop');
results.push(['A 桌面侧栏可见', p.asideRect && p.asideRect.x === 0 && p.btnDisplay === 'none']);

// ── B. 平板竖屏：侧栏移出屏外、菜单键出现 ──
await viewport(820, 1180); await sleep(900);
p = await probe(); row('【B】平板竖屏 820×1180（期望：侧栏 x 为负/移出、菜单键 inline-flex）', p);
await shot('B-tablet-closed');
results.push(['B 窄屏侧栏移出', p.asideRect && p.asideRect.x < 0 && p.btnDisplay !== 'none']);

// ── C. 点菜单键：抽屉滑出 + 遮罩出现 ──
await evaluate(`document.querySelector('#nav-drawer-btn').click()`);
await sleep(600);
p = await probe(); row('【C】点菜单键后（期望：侧栏 x≈0、遮罩 display:block、nav-open=true）', p);
await shot('C-tablet-open');
results.push(['C 抽屉可打开', p.navOpen && p.asideRect && p.asideRect.x === 0 && p.backdropDisplay === 'block']);

// ── D. 点遮罩：收起 ──
await evaluate(`document.querySelector('#nav-backdrop').click()`);
await sleep(600);
p = await probe(); row('【D】点遮罩后（期望：收起、nav-open=false）', p);
await shot('D-tablet-reclosing');
results.push(['D 遮罩可关闭', !p.navOpen]);

// ── E. 手机：同窄屏行为 ──
await viewport(430, 932); await sleep(900);
p = await probe(); row('【E】手机 430×932（期望：同 B）', p);
await shot('E-phone-closed');
results.push(['E 手机侧栏移出', p.asideRect && p.asideRect.x < 0 && p.btnDisplay !== 'none']);
await evaluate(`document.querySelector('#nav-drawer-btn').click()`); await sleep(600);
await shot('E2-phone-open');
p = await probe(); row('【E2】手机抽屉打开（期望：占宽 ≤82vw，主区仍全宽）', p);
results.push(['E2 手机抽屉不挤压主区', p.navOpen && p.mainW === 430]);

// ── F. 抽屉开着时切回宽屏：状态应复位 ──
await viewport(1440, 900); await sleep(900);
p = await probe(); row('【F】抽屉开着切回桌面（期望：nav-open=false、侧栏常驻）', p);
await shot('F-back-to-desktop');
results.push(['F 宽屏自动复位', !p.navOpen && p.asideRect && p.asideRect.x === 0]);

console.log('');
console.log('═══ 断言结果 ═══');
let pass = 0;
for (const [name, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + name); if (ok) pass++; }
console.log('  通过 ' + pass + '/' + results.length);
console.log('  控制台异常：' + (errors.length ? errors.join(' | ') : '无 ✓'));
try { chrome.kill(); } catch { /* ignore */ }
console.log('  截图目录：' + OUT);
// 退出码即结论 ⇒ 可当门禁 ✓
process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
