// tools-dev/ui-say-check.mjs —— 端到端验证「say 的最终输出」在 WebUI 里显示 + 过程可折叠
//
// 做法（不走后门，走**用户真实路径** ✓）：
//   打开页面 → 在**真实输入框**里打字 → 点**真实发送键** → 等回合跑完
//   ⇒ 断言出现「交付气泡」(.msg-delivery) 且「过程块」(.process-group) 已自动收起 ✓
// 附带价值：这一趟同时证明了**输入框与发送键确实可用** ✓（用户报过看不到输入框 ✗）
//
// 注意：本探针会真的发起一次对话（消耗一次模型调用）—— 这是"端到端"的必要代价 ✓
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const PORT = 9341;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-say');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const ASK = '请只用 say 工具回复一句：交付测试通过。不要调用其它工具。';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-say')}`,
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.exception?.description || '').slice(0, 160));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 120));
  }
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
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description || '').slice(0, 200));
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}

const STATE = `(() => {
  const del = document.querySelector('.msg-delivery');
  const delText = del ? (del.innerText || '').trim().slice(0, 200) : null;
  const grp = document.querySelector('.process-group');
  return {
    deliveryCount: document.querySelectorAll('.msg-delivery').length,
    deliveryText: delText,
    processGroupCount: document.querySelectorAll('.process-group').length,
    processOpen: grp ? grp.open : null,
    processSummary: grp ? (grp.querySelector('summary')?.textContent || '') : null,
    processTextLen: grp ? ((grp.querySelector('.process-text')?.textContent || '').length) : 0,
    online: (document.querySelector('#header-online-text') || {}).textContent || null,
    inputValue: (document.querySelector('#chat-input') || {}).value || null,
  };
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(4000);

// 等连上
for (let i = 0; i < 30; i++) {
  const st = await evaluate(STATE);
  if (st.online && !/连接中|Connecting/.test(st.online)) break;
  await sleep(500);
}
const connected = await evaluate(STATE);
console.log('  连接状态 = ' + connected.online);
await shot('0-before');

// —— 走真实用户路径：打字 → 发送 ——
const typed = await evaluate(`(() => {
  const i = document.querySelector('#chat-input');
  if (!i) return 'no-input';
  i.value = ${JSON.stringify(ASK)};
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return i.value.slice(0, 30);
})()`);
console.log('  已填入输入框 = ' + typed);
const clicked = await evaluate(`(() => {
  const b = document.querySelector('#chat-send-btn');
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()`);
console.log('  点发送键 = ' + clicked);

// 等交付气泡（最多 120s）
let sawDelivery = false;
let last = null;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  last = await evaluate(STATE);
  if (last.deliveryCount > 0) { sawDelivery = true; break; }
}
console.log('  wait 结果：交付气泡数=' + (last ? last.deliveryCount : '?') +
  '  过程块数=' + (last ? last.processGroupCount : '?') +
  '  过程块展开=' + (last ? last.processOpen : '?') +
  '  过程文本长度=' + (last ? last.processTextLen : '?'));
if (last && last.deliveryText) console.log('  交付正文 = 「' + last.deliveryText.replace(/\s+/g, ' ').slice(0, 80) + '」');
await shot('1-after');

console.log('');
const results = [
  ['① 端到端：say 交付气泡出现', sawDelivery],
  ['② 交付正文非空', !!(last && last.deliveryText && last.deliveryText.length > 0)],
  ['③ 过程块存在（工具/文本被收进去）', !!(last && last.processGroupCount > 0)],
  ['④ 交付到达后过程块自动收起', !!(last && last.processOpen === false)],
  ['⑤ 无控制台异常', errors.length === 0],
];
// ── 历史回放阶段（换会话/刷新后，交付还能不能正确显示 ✓）──────────────────
// 走真实用户路径：会话管理 → 点「加载」刚用的那个会话 → 看历史里
//   ① 是否出现「交付气泡」(.msg-delivery) ② 过程是否收进折叠块
// 为什么必须测这一段：交付正文在 events.jsonl 里是 say 的 tool_call（input.content），
//   历史渲染若认不出它，就会把整段正文**埋进一个折叠的工具小条**里 ✗（原状）
let histDelivery = 0;
let histGroups = 0;
try {
  await evaluate(`location.hash = '#/sessions'`);
  await sleep(1500);
  for (let i = 0; i < 30; i++) {
    const n = await evaluate(`document.querySelectorAll('#sessions-tbody button[data-action="load"]').length`);
    if (n > 0) break;
    await sleep(500);
  }
  const sid = await evaluate(`(() => { const r = document.querySelector('#sessions-tbody tr'); return r ? (r.dataset.sessionId || '') : ''; })()`);
  const clicked = await evaluate(`(() => { const b = document.querySelector('#sessions-tbody button[data-action="load"]'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`);
  console.log('  历史阶段：加载会话 ' + (sid || '(首行)') + ' ⇒ ' + clicked);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const st = await evaluate(`(() => ({
      d: document.querySelectorAll('.msg-delivery').length,
      g: document.querySelectorAll('.process-group').length,
    }))()`);
    histDelivery = st.d; histGroups = st.g;
    if (st.d > 0) break;
  }
  const h = await evaluate(`(() => { const ml = document.querySelector('#message-list'); return { kids: ml ? ml.children.length : 0, text: ml ? (ml.innerText || '') : '' }; })()`);
  console.log('  历史阶段结果：交付气泡=' + histDelivery + '  过程块=' + histGroups + '  列表子节点=' + h.kids);
  if (h.text) console.log('  历史文本节选 = 「' + h.text.replace(/\s+/g, ' ').slice(0, 100) + '」');
  await shot('2-history');
} catch (e) {
  console.log('  历史阶段异常：' + e.message);
}
results.push(['⑥ 历史回放：交付气泡出现（不再被埋进工具小条）', histDelivery > 0]);
results.push(['⑦ 历史回放：过程收进折叠块', histGroups > 0]);

let pass = 0;
for (const [n, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++; }
console.log(`Σ ${pass}/${results.length}`);
if (errors.length) for (const e of errors.slice(0, 6)) console.log('  ✗ ' + e);
console.log('截图：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
process.exit(pass === results.length ? 0 : 1);
