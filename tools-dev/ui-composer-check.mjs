// ui-composer-check.mjs —— 专查「输入框（发消息的地方）在不在、在哪」
// 用户实报：主页看不到发消息的地方 ✗ ⇒ 先把 composer/input 的可见性与坐标量出来 ✓
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const PORT = 9340;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-composer');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-composer')}`,
  '--window-size=1440,900', 'about:blank',
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.exception?.description || '').slice(0, 200));
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(method)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description || '').slice(0, 200));
  return r.result?.value;
}
const viewport = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 900 });
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}

const PROBE = `(() => {
  const q = (sel) => document.querySelector(sel);
  const info = (sel) => {
    const el = q(sel);
    if (!el) return { sel, exists: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // 逐级向上找出「把它藏起来或挤出可视区」的祖先
    let culprit = null, p = el;
    while (p && p !== document.documentElement) {
      const pcs = getComputedStyle(p);
      if (pcs.display === 'none') { culprit = 'display:none@' + (p.id ? '#' + p.id : p.tagName); break; }
      if (pcs.visibility === 'hidden') { culprit = 'visibility:hidden@' + (p.id ? '#' + p.id : p.tagName); break; }
      p = p.parentElement;
    }
    return {
      sel, exists: true,
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      hiddenAttr: el.hidden === true,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      inViewport: r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0,
      culprit,
    };
  };
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    view: (location.hash || '#/chat'),
    shellH: Math.round((q('#app-shell') || {}).getBoundingClientRect ? q('#app-shell').getBoundingClientRect().height : -1),
    chatWrapper: info('#chat-wrapper'),
    msgList: info('#message-list'),
    empty: info('#chat-empty'),
    composer: info('#chat-composer'),
    input: info('#chat-input'),
    sendBtn: info('#chat-send-btn'),
    bodyScrollH: document.body.scrollHeight,
    supportsDvh: CSS.supports('height', '100dvh'),
    shellComputedH: (() => { const s = q('#app-shell'); return s ? Math.round(s.getBoundingClientRect().height) : null; })(),
    composerBottomGap: (() => { const c = q('#chat-composer'); if (!c) return null; return Math.round(window.innerHeight - c.getBoundingClientRect().bottom); })(),
  };
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(3800);

for (const [w, h] of [[1440, 900], [1180, 560], [820, 620], [430, 620], [820, 1180], [1180, 820]]) {
  await viewport(w, h); await sleep(800);
  await evaluate(`location.hash = '#/chat'`); await sleep(1200);
  const r = await evaluate(PROBE);
  console.log(`【${r.view}】${w}×${h}  视口=${r.vw}×${r.vh}  shell高=${r.shellH}`);
  for (const k of ['chatWrapper', 'msgList', 'empty', 'composer', 'input', 'sendBtn']) {
    const i = r[k];
    if (!i.exists) { console.log(`    ✗ ${k}: 元素不存在`); continue; }
    const flag = i.inViewport ? '可见 ✓' : '**不可见 ✗**';
    console.log(`    ${i.inViewport ? '·' : '✗'} ${k}: ${flag}  display=${i.display} ${i.hiddenAttr ? 'hidden属性=真' : ''} 位置=(${i.x},${i.y}) 尺寸=${i.w}×${i.h}${i.culprit ? '  真凶=' + i.culprit : ''}`);
  }
  await shot('chat-' + w);
}
console.log('');
console.log('控制台异常：' + (errors.length ? errors.join(' | ') : '无 ✓'));
console.log('截图：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
process.exit(0);
