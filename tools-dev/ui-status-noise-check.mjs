// tools-dev/ui-status-noise-check.mjs —— 「两页实验」：验证状态噪音已止（用户截图问题的判据 ✓）
//
// 用户报（2026-09-20 截图）：网页上同一句 `maxContextTokens updated to 600000` 堆了 7 行 ✗
//
// 根因：配置中心是**进程级单例** ⇒ 任何一处写配置 ⇒ **所有会话的 watch 都回调** ✗
//       ⇒ 每个会话都往自己的界面推一条；且那句的值**根本没变** ✗
// 修法：`loop-provider.ts` 两个 watch 改成**值真变了才推** ✓
//
// 判据（这才是"过去会犯、现在不犯"的对照 ✓）：
//   开 **A** 页面（记 baseline）⇒ 再开 **B** 页面（= 新会话 = 过去会触发噪音的动作 ✗）
//   ⇒ 断言 **A 的 `maxContextTokens` 行数 增量为 0** ✓
//   （只看"A 自己有没有那条行"是不够的 ✗ —— A 自己首次加载时可能真发生一次变更 ✓）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './_chrome.mjs';

const BASE = 'http://127.0.0.1:3100/';
const OUT = path.join(process.env.TEMP || '.', 'webui-noise');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

/** 开一个独立浏览器实例（= 服务端眼里的一个独立客户端/会话 ✓） */
async function openPage(tag, port) {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(process.env.TEMP || '.', 'chrome-noise-' + tag)}`,
    '--window-size=820,1180', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const l = await r.json();
      const p = l.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) wsUrl = p.webSocketDebuggerUrl;
    } catch { /* retry */ }
    if (!wsUrl) await new Promise((r) => setTimeout(r, 250));
  }
  if (!wsUrl) throw new Error(tag + '：CDP 未就绪');
  const ws = new WebSocket(wsUrl);
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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description || '').slice(0, 160));
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');

  const t0 = Date.now();
  await send('Page.navigate', { url: BASE });
  let usableMs = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const txt = await evaluate(`(document.querySelector('#header-online-text') || {}).textContent || ''`);
    if (txt && !/连接中|Connecting/.test(txt)) { usableMs = Date.now() - t0; break; }
  }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  /** 数"幻影行"：聊天区里出现 maxContextTokens 的行数 ✓ */
  const countNoise = () => evaluate(`(() => {
    const ml = document.querySelector('#message-list');
    const t = ml ? (ml.innerText || '') : '';
    return (t.match(/maxContextTokens/gi) || []).length;
  })()`);

  return { tag, chrome, evaluate, sleep, shot, countNoise, usableMs, errors };
}

console.log('  ① 开页面 A（保持不关 ✓）…');
const A = await openPage('a', 9351);
await A.sleep(4000);                      // 让 A 自己那一次首屏逻辑跑完（那属于"真变更"范畴 ✓）
const aBase = await A.countNoise();
console.log('     A 首屏就绪 = ' + A.usableMs + 'ms；幻影行 baseline = ' + aBase);
await A.shot('1-page-a');

console.log('  ② 再开页面 B（= 新会话 ⇒ 这正是**过去**会让 A 凭空多一行的动作 ✗）…');
const B = await openPage('b', 9352);
await B.sleep(3000);
const bCount = await B.countNoise();
console.log('     B 首屏就绪 = ' + B.usableMs + 'ms；B 自己的幻影行 = ' + bCount);
await B.shot('2-page-b');

console.log('  ③ 静置 8 秒（给"跨会话扇出"充分机会 ✗）…');
await A.sleep(8000);
const aAfter = await A.countNoise();
await A.shot('3-page-a-after');

const delta = aAfter - aBase;
console.log('');
console.log('  A：baseline ' + aBase + ' → 开 B 之后 ' + aAfter + '   增量 = ' + delta + (delta === 0 ? '  ✓（一行都没涨 ✓）' : '  ✗（仍在扇出 ✗）'));
console.log('');

const results = [
  ['① A、B 两页都正常可用（首屏就绪）', A.usableMs !== null && B.usableMs !== null],
  ['② 开 B 之后，**A 的幻影行增量为 0** ✓（本次修复的核心判据）', delta === 0],
  ['③ B 自己没有幻影行', bCount === 0],
  ['④ 无控制台异常', A.errors.length === 0 && B.errors.length === 0],
];
let pass = 0;
for (const [n, ok] of results) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++; }
console.log('Σ ' + pass + '/' + results.length);
for (const e of [...A.errors, ...B.errors].slice(0, 5)) console.log('  ✗ ' + e);
console.log('截图：' + OUT);
try { A.chrome.kill(); } catch { /* ignore */ }
try { B.chrome.kill(); } catch { /* ignore */ }
process.exit(pass === results.length ? 0 : 1);
