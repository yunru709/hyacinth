// tools-dev/ui-schedule-check.mjs —— 定时任务视图的**端到端行为验证**
//
// 为什么必须验行为（接线 ≠ 能用 ✗）：对账只能证明"方法被调用了"，
// 证明不了"点下去真的生效" ✗。这里走完整链路：
//   进视图 → 填表添加 → 列表出现 → 停用 → 删除（两段确认）→ 列表消失
// ⚠️ 会**真建一条任务再删掉**（自我清理 ✓，避免污染用户的定时任务 ✓）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const PORT = 9347;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-schedule');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const NAME = '探针自测任务';
const TIME = '23:59';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-sched')}`,
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

/** 找含指定文本的任务行，并对其中的控件做操作 ✓ */
const ROW_HELPERS = `
  window.__probeRow = (text) => [...document.querySelectorAll('#schedule-list [class*="bg-card"]')]
    .find((n) => (n.innerText || '').includes(text)) || null;
  window.__probeCount = () => document.querySelectorAll('#schedule-list input[type=checkbox]').length;
`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE + '#/schedule' });
await sleep(4500);
for (let i = 0; i < 30; i++) {
  const ok = await evaluate(`(document.querySelector('#header-online-text') || {}).textContent || ''`);
  if (ok && !/连接中|Connecting/.test(ok)) break;
  await sleep(500);
}
// 确保在 schedule 视图（hash 校验 + 强制切换一次 ✓）
await evaluate(`location.hash = '#/schedule'`);
await sleep(1500);
await evaluate(ROW_HELPERS);

const view = await evaluate(`(() => {
  const sec = document.querySelector('section[data-view="schedule"]');
  return {
    sectionExists: !!sec,
    visible: !!(sec && !sec.hidden),
    hasList: !!document.querySelector('#schedule-list'),
    hasForm: !!(document.querySelector('#schedule-name') && document.querySelector('#schedule-add-btn')),
    status: (document.querySelector('#schedule-status') || {}).textContent || '',
    navActive: !!(document.querySelector('[data-nav-item="schedule"]') && document.querySelector('[data-nav-item="schedule"]').classList.contains('nav-active')),
  };
})()`);
console.log('  视图：存在=' + view.sectionExists + ' 可见=' + view.visible + ' 有列表=' + view.hasList + ' 有表单=' + view.hasForm + ' 导航高亮=' + view.navActive);
console.log('  状态行 = 「' + view.status + '」');
const before = await evaluate(`window.__probeCount()`);
console.log('  现有任务数 = ' + before);
await shot('1-view');

// ── 添加 ────────────────────────────────────────────────────
await evaluate(`(() => {
  document.querySelector('#schedule-name').value = ${JSON.stringify(NAME)};
  document.querySelector('#schedule-type').value = 'daily';
  document.querySelector('#schedule-value').value = ${JSON.stringify(TIME)};
  document.querySelector('#schedule-add-btn').click();
})()`);
await sleep(2500);
const afterAdd = await evaluate(`({ count: window.__probeCount(), has: !!window.__probeRow(${JSON.stringify(NAME)}), hint: (document.querySelector('#schedule-hint')||{}).textContent || '' })`);
console.log('  添加后：任务数=' + afterAdd.count + '（原 ' + before + '） 新行存在=' + afterAdd.has + ' 提示=「' + afterAdd.hint + '」');
await shot('2-added');

// ── 停用（开关）─────────────────────────────────────────────
const toggled = await evaluate(`(() => {
  const row = window.__probeRow(${JSON.stringify(NAME)});
  if (!row) return 'no-row';
  const sw = row.querySelector('input[type=checkbox]');
  if (!sw) return 'no-switch';
  const was = sw.checked;
  sw.click();
  return { was, now: sw.checked };
})()`);
await sleep(1800);
const afterToggle = await evaluate(`(() => {
  const row = window.__probeRow(${JSON.stringify(NAME)});
  const sw = row ? row.querySelector('input[type=checkbox]') : null;
  return sw ? sw.checked : null;
})()`);
console.log('  停用：点击前=' + (toggled && toggled.was) + ' 点击后=' + (toggled && toggled.now) + ' 刷新后=' + afterToggle);

// ── 删除（两段确认 ✓）──────────────────────────────────────
const delStep = await evaluate(`(() => {
  const row = window.__probeRow(${JSON.stringify(NAME)});
  if (!row) return 'no-row';
  const btns = [...row.querySelectorAll('button')];
  const del = btns[btns.length - 1];
  del.click();
  const first = del.textContent;
  return { first };
})()`);
await sleep(400);
const delStep2 = await evaluate(`(() => {
  const row = window.__probeRow(${JSON.stringify(NAME)});
  if (!row) return 'no-row';
  const btns = [...row.querySelectorAll('button')];
  const del = btns[btns.length - 1];
  del.click();
  return 'clicked2';
})()`);
await sleep(2500);
const afterDel = await evaluate(`({ count: window.__probeCount(), has: !!window.__probeRow(${JSON.stringify(NAME)}) })`);
console.log('  删除：第一次点击后按钮文案=「' + (delStep && delStep.first) + '」 → ' + delStep2 + ' ⇒ 行还在=' + afterDel.has + ' 任务数=' + afterDel.count);
await shot('3-deleted');

const results = [
  ['① 视图可进入且渲染完整（列表 ＋ 表单 ＋ 导航高亮）', view.visible && view.hasList && view.hasForm && view.navActive],
  ['② 添加生效（新任务出现在列表里）', afterAdd.has === true && afterAdd.count === before + 1],
  ['③ 停用开关生效（后端确认后状态保持）', afterToggle === false],
  ['④ 删除走两段确认（第一击只改文案）', String(delStep && delStep.first).includes('确认')],
  // ⚠️ ⑤ 必须**附加"② 先成功"**这一条：否则行本来就不存在 ⇒ 恒真 ⇒ **空集合假绿** ✗（本轮真踩了 ✓）
  ['⑤ 删除生效（行消失 ＋ 数量回落；且须②已成功才计数）', afterDel.has === false && afterDel.count === before && afterAdd.has === true],
  ['⑥ 无控制台异常', errors.length === 0],
];
console.log('');
let pass = 0;
for (const [n, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++; }
console.log('Σ ' + pass + '/' + results.length);
if (errors.length) for (const e of errors.slice(0, 5)) console.log('  ✗ ' + e);
console.log('截图：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
process.exit(pass === results.length ? 0 : 1);
