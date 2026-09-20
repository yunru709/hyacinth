// ui-final.mjs —— 收尾验收：四视图 × 四视口，**剔除三类误报**后只剩真问题
//   误报 1：.sr-only（屏幕阅读器专用，故意 1px + clip）
//   误报 2：带 text-overflow:ellipsis 的元素（故意截断显示 …）
//   误报 3：位于 overflow-x:auto/scroll 容器内部的元素（合法溢出 ⇒ 本就能滚）
// 另加两条硬断言：设置开关宽度 ≥36px；会话操作按钮高 ≤30px（且必须**真找到**按钮 ✓）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CHROME } from './_chrome.mjs';
const PORT = 9338;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-final');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-final')}`,
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.exception?.description || '').slice(0, 120));
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
const viewport = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 900 });
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}

const AUDIT = `(() => {
  const inScroller = (el) => {
    let p = el.parentElement;
    while (p) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll') return true; p = p.parentElement; }
    return false;
  };
  const vw = window.innerWidth, vh = window.innerHeight;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.position === 'fixed') continue;
    if (el.closest('.sr-only') || el.classList.contains('sr-only')) continue;
    if (cs.textOverflow === 'ellipsis') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right > vw + 2 && !inScroller(el)) bad.push({ t: el.tagName, id: el.id, right: Math.round(r.right), txt: (el.textContent || '').trim().slice(0, 20) });
  }
  const toggles = [...document.querySelectorAll('.settings-toggle')].map((t) => Math.round(t.getBoundingClientRect().width));
  const sessBtns = [...document.querySelectorAll('#sessions-tbody button[data-action]')].map((b) => Math.round(b.getBoundingClientRect().height));
  return {
    vw, vh,
    docW: document.documentElement.scrollWidth,
    bodyW: document.body.scrollWidth,
    overflow: bad.slice(0, 8),
    toggleMin: toggles.length ? Math.min(...toggles.filter((x) => x > 0)) : null,
    sessBtnCount: sessBtns.length,
    sessBtnMax: sessBtns.length ? Math.max(...sessBtns) : null,
  };
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(3600);

const results = [];
const SIZES = [[1440, 900], [1180, 820], [820, 1180], [430, 932]];
const VIEWS = ['chat', 'model', 'sessions', 'settings'];

for (const [w, h] of SIZES) {
  await viewport(w, h); await sleep(700);
  for (const v of VIEWS) {
    await evaluate(`location.hash = '#/${v}'`);
    await sleep(1200);
    // 会话页要**轮询等行**再断言 —— 固定 sleep 会偶发"样本为空"误判 ✗（我自己踩过 ✓）
    if (v === 'sessions') {
      for (let i = 0; i < 30; i++) {
        const n = await evaluate(`document.querySelectorAll('#sessions-tbody button[data-action]').length`);
        if (n > 0) break;
        await sleep(500);
      }
    }
    const r = await evaluate(AUDIT);
    const pageOverflow = r.docW > r.vw + 1 || r.bodyW > r.vw + 1;
    const ok = r.overflow.length === 0 && !pageOverflow;
    results.push([`${v}@${w} 无越界（页级=${pageOverflow ? '有 ✗' : '无 ✓'}）`, ok]);
    let line = `【${v}】${w}×${h}  视口=${r.vw}  文档宽=${r.docW}`;
    if (r.overflow.length) line += `  ✗ 越界 ${r.overflow.length} 处`;
    else line += '  ✓ 无越界';
    if (v === 'settings' && r.toggleMin !== null) {
      const togOk = r.toggleMin >= 36;
      line += `  开关最小宽=${r.toggleMin}${togOk ? ' ✓' : ' ✗'}`;
      results.push([`settings@${w} 开关未被压扁`, togOk]);
    }
    if (v === 'sessions') {
      if (r.sessBtnCount === 0) { line += '  ✗ 未找到操作按钮（样本为空，不判 ✓）'; results.push([`sessions@${w} 按钮存在`, false]); }
      else {
        const ok2 = r.sessBtnMax <= 30;
        line += `  操作按钮数=${r.sessBtnCount} 最大高=${r.sessBtnMax}${ok2 ? ' ✓ 单行' : ' ✗ 折行'}`;
        results.push([`sessions@${w} 按钮单行`, ok2]);
      }
    }
    console.log(line);
    if (r.overflow.length) for (const o of r.overflow) console.log(`      ✗ <${o.t}${o.id ? '#' + o.id : ''}> right=${o.right} 「${o.txt}」`);
    await shot(`${v}-${w}`);
  }
}

// 视觉证据：抽屉打开态（平板竖屏 + 手机）
await viewport(820, 1180); await sleep(600);
await evaluate(`location.hash = '#/chat'`); await sleep(1200);
await evaluate(`document.querySelector('#nav-drawer-btn').click()`); await sleep(700);
await shot('drawer-open-tablet');
await viewport(430, 932); await sleep(700);
await evaluate(`document.querySelector('#nav-drawer-btn').click()`); await sleep(700);
await shot('drawer-open-phone');

console.log('');
let pass = 0;
for (const [n, ok] of results) { if (ok) pass++; else console.log('  ✗ ' + n); }
console.log(`✓ ${pass}/${results.length} 项通过`);
console.log('控制台异常：' + (errors.length ? errors.join(' | ') : '无 ✓'));
console.log('截图目录：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
// 退出码即结论 ⇒ 可直接当门禁用（别只信输出里的字符串 ✗）
process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
