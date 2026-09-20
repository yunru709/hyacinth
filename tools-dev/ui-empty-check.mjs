// ui-empty-check.mjs —— 定向验证「对话空状态」四条行为
//   ① 首屏（无消息）：引导可见、消息区隐藏
//   ② 点建议：内容**填入输入框**，且**不自动发送**（仍停在首屏）
//   ③ 出现消息（注入假节点触发 MutationObserver）：引导自动收起、消息区显示
//   ④ 消息清空：引导自动回来（可反复 ✓）；全程无控制台异常
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CHROME } from './_chrome.mjs';
const PORT = 9339;
const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-empty');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-empty')}`,
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error');
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
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description || '').slice(0, 180));
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}
const STATE = `(() => {
  const e = document.querySelector('#chat-empty');
  const m = document.querySelector('#message-list');
  const i = document.querySelector('#chat-input');
  const vis = (el) => {
    if (!el) return 'missing';
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const shown = cs.display !== 'none' && !el.hidden && r.width > 0 && r.height > 0;
    return shown ? 'visible' : 'hidden';
  };
  return {
    empty: vis(e), list: vis(m),
    inputValue: i ? i.value : null,
    suggestionCount: document.querySelectorAll('#chat-empty .chat-suggestion').length,
    listChildren: m ? m.children.length : -1,
  };
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1180, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(3600);
await evaluate(`location.hash = '#/chat'`); await sleep(1200);

const results = [];
const s0 = await evaluate(STATE);
console.log(`① 首屏：引导=${s0.empty}  消息区=${s0.list}  建议数=${s0.suggestionCount}  消息区子节点=${s0.listChildren}`);
results.push(['① 首屏引导可见 + 消息区隐藏', s0.empty === 'visible' && s0.list === 'hidden' && s0.suggestionCount === 3]);
await shot('1-empty');

// ② 点第一条建议
await evaluate(`document.querySelector('#chat-empty .chat-suggestion').click()`);
await sleep(500);
const s1 = await evaluate(STATE);
console.log(`② 点建议后：输入框="${s1.inputValue}"  引导=${s1.empty}  消息区子节点=${s1.listChildren}`);
results.push(['② 建议填入输入框', typeof s1.inputValue === 'string' && s1.inputValue.length > 0]);
results.push(['② 未自动发送（仍停首屏）', s1.empty === 'visible' && s1.listChildren === 0]);
await shot('2-suggestion-filled');

// ③ 注入假消息节点 → 观察器应自动切换
// ★ 教训（当场踩到 ✗）：**应用自身的渲染会在轮询/重绘里清空列表** ⇒ 注入可能被清掉 ⇒
//   所以这里必须「**边注入边轮询**」，且第④步删除时**要守卫 null**（否则探针自己抛错崩掉 ✗）
let injectedOk = false;
let s2 = null;
for (let i = 0; i < 12; i++) {
  await evaluate(`(() => {
    const ml = document.querySelector('#message-list');
    if (!ml) return;
    if (!document.querySelector('#probe-msg')) {
      const d = document.createElement('div');
      d.id = 'probe-msg';
      d.textContent = 'probe';
      ml.appendChild(d);
    }
  })()`);
  await sleep(250);
  s2 = await evaluate(STATE);
  if (s2.empty === 'hidden' && s2.list === 'visible') { injectedOk = true; break; }
}
console.log(`③ 有消息后：引导=${s2 ? s2.empty : '?'}  消息区=${s2 ? s2.list : '?'}  子节点=${s2 ? s2.listChildren : '?'}`);
results.push(['③ 有消息 ⇒ 引导自动收起、消息区显示', injectedOk]);
await shot('3-with-message');

// ④ 清空 → 引导应回来（守卫：节点可能已被应用清掉 ⇒ 不能直接 .remove() ✗）
await evaluate(`(() => { const n = document.querySelector('#probe-msg'); if (n) n.remove(); })()`);
await sleep(500);
const s3 = await evaluate(STATE);
console.log(`④ 清空后：引导=${s3.empty}  消息区=${s3.list}  子节点=${s3.listChildren}`);
results.push(['④ 清空 ⇒ 引导自动回来', s3.empty === 'visible' && s3.list === 'hidden']);
await shot('4-back-to-empty');

console.log('');
let pass = 0;
for (const [n, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++; }
console.log(`Σ ${pass}/${results.length}`);
console.log('控制台异常：' + (errors.length ? errors.join(' | ') : '无 ✓'));
console.log('截图：' + OUT);
try { chrome.kill(); } catch { /* ignore */ }
// 退出码即结论 ⇒ 可当门禁 ✓
process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
