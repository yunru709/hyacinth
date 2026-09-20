// tools-dev/ui-system-check.mjs —— 「系统」设置页的端到端行为验证
//
// 为什么必须验（今天的教训 ✓）：补丁全绿 ≠ 能用 ✗ ⇒ 真去点开关、真去看数字 ✓
// 判据：
//   ① 「系统」面板能打开，且**其它面板确实隐藏**（我加的隐藏 CSS 要对 ✓ 否则两个面板叠着显示 ✗）
//   ② 编排器开关：读得到状态 → 点一下真翻（并能在说明文字里看到变化 ✓）→ 再点回去（**复原** ✓）
//   ③ 会话统计：显示**真实数字**（不是 "—"、不是"取不到" ✗）
//   ④ 后台进程：给出列表或空态（不报错 ✓）
//   ⑤ 命令跳页：发 `/schedule` ⇒ **跳到定时任务页**（而不是把结果打在聊天里 ✗）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const PORT = 9349;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-system');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-sys')}`,
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
await send('Page.navigate', { url: BASE + '#/settings' });
await sleep(4500);
for (let i = 0; i < 30; i++) {
  const ok = await evaluate(`(document.querySelector('#header-online-text') || {}).textContent || ''`);
  if (ok && !/连接中|Connecting/.test(ok)) break;
  await sleep(500);
}
await evaluate(`location.hash = '#/settings'`);
await sleep(1200);

// ── ① 打开「系统」tab ────────────────────────────────────────
await evaluate(`(() => { const l = document.querySelector('label[for="tab-system"]'); if (l) l.click(); })()`);
await sleep(2000);
const view = await evaluate(`(() => {
  const p = document.querySelector('#panel-system');
  const cs = p ? getComputedStyle(p) : null;
  const ctx = document.querySelector('#panel-context');
  const ctxShown = ctx ? getComputedStyle(ctx).display !== 'none' : null;
  return {
    exists: !!p,
    shown: cs ? cs.display !== 'none' : false,
    ctxShown,
    orchDesc: (document.querySelector('#orch-desc') || {}).textContent || '',
    statsDesc: (document.querySelector('#session-stats-desc') || {}).textContent || '',
    procText: (document.querySelector('#proc-list') || {}).innerText || '',
    hasToggle: !!document.querySelector('#orch-toggle'),
  };
})()`);
console.log('  ① 系统面板：存在=' + view.exists + ' 显示=' + view.shown + ' 上下文面板仍显示=' + view.ctxShown);
console.log('     编排器说明 = 「' + view.orchDesc + '」');
console.log('     会话统计 = 「' + view.statsDesc + '」');
console.log('     进程区 = 「' + view.procText.replace(/\s+/g, ' ').slice(0, 70) + '」');
await shot('1-system');

// ── ② 编排器开关：开 → 关（复原 ✓）────────────────────────
const before = await evaluate(`(document.querySelector('#orch-toggle') || {}).checked`);
await evaluate(`(() => { document.querySelector('#orch-toggle').click(); })()`);
await sleep(2500);
const afterOn = await evaluate(`({ checked: (document.querySelector('#orch-toggle')||{}).checked, desc: (document.querySelector('#orch-desc')||{}).textContent || '' })`);
await evaluate(`(() => { const t = document.querySelector('#orch-toggle'); if (t && t.checked) t.click(); })()`);
await sleep(2500);
const afterOff = await evaluate(`({ checked: (document.querySelector('#orch-toggle')||{}).checked, desc: (document.querySelector('#orch-desc')||{}).textContent || '' })`);
console.log('  ② 开关：初始=' + before + ' → 开启后=' + afterOn.checked + '（「' + afterOn.desc.slice(0, 40) + '」）→ 复原后=' + afterOff.checked);
await shot('2-toggled');

// ── ③ 命令跳页：/schedule ⇒ 跳到定时任务页 ──────────────────
await evaluate(`location.hash = '#/chat'`);
await sleep(800);
await evaluate(`(() => {
  const i = document.querySelector('#chat-input');
  i.value = '/schedule';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#chat-send-btn').click();
})()`);
await sleep(1800);
const navigated = await evaluate(`(() => {
  const sec = document.querySelector('section[data-view="schedule"]');
  return {
    hash: location.hash,
    scheduleShown: !!(sec && !sec.hidden),
    delivery: document.querySelectorAll('.msg-delivery').length,
  };
})()`);
console.log('  ③ /schedule ⇒ hash=' + navigated.hash + ' 定时任务页显示=' + navigated.scheduleShown + ' 交付气泡=' + navigated.delivery);
await shot('3-nav');

const results = [
  ['① 系统面板可打开，且其它面板已隐藏', view.exists && view.shown && view.ctxShown === false],
  ['② 编排器状态读到了（不是「加载中…」/「取不到」）', !!view.orchDesc && !/加载中|取不到/.test(view.orchDesc)],
  ['③ 开关能翻（开 → 说明文字变化）', afterOn.checked === true && afterOn.desc !== view.orchDesc],
  ['④ 开关能复原（回到初始状态，不留副作用）', afterOff.checked === before],
  ['⑤ 会话统计显示真实数字（不是「—」/「取不到」）', !!view.statsDesc && view.statsDesc !== '—' && !/取不到/.test(view.statsDesc)],
  ['⑥ 进程区正常（空态或列表，不报错）', !/取不到/.test(view.procText)],
  ['⑦ 命令跳页：/schedule 切到定时任务页（且没走模型 ✓）', navigated.scheduleShown === true && navigated.delivery === 0],
  ['⑧ 无控制台异常', errors.length === 0],
];
console.log('');
let pass = 0;
for (const [n, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++; }
console.log('Σ ' + pass + '/' + results.length);
if (errors.length) for (const e of errors.slice(0, 5)) console.log('  ✗ ' + e);
console.log('截图：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
process.exit(pass === results.length ? 0 : 1);
