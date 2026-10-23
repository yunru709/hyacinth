#!/usr/bin/env node
/**
 * 验收探针：页面里的 Flash 是否被 Ruffle 扩展接管 —— 零依赖 CDP
 *
 * 用法: node tools-dev/gui/cdp-flash-check.mjs <url> [waitMs] [shotPath]
 * 端口: CDP_PORT 环境变量（默认 9224 —— Ruffle 验收用的 Edge 实例）
 *
 * 判据（三层，别只看一个）：
 *   ① 是否出现 <ruffle-player> 之类的自定义元素（扩展接管成功的直接证据）
 *   ② 页面里还剩多少 <object>/<embed>（没被替换 = 没接管）
 *   ③ 截图（肉眼确认真的画出游戏画面，而不是"结构对了但黑屏"）
 */
const port = process.env.CDP_PORT || 9224;
const url = process.argv[2];
const waitMs = Number(process.argv[3] || 9000);
const shotPath = process.argv[4] || '';
if (!url) {
  console.error('用法: node tools-dev/gui/cdp-flash-check.mjs <url> [waitMs] [shotPath]');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('  ❌ 找不到 page target（浏览器没带 --remote-debugging-port？）');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const send = (method, params) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', () => j(new Error('CDP WS 连接失败')));
});

await send('Page.enable');
await send('Page.navigate', { url });
// 等 load 事件（最多 30s），再额外等 waitMs 让 swf 解析/首帧
await new Promise((res) => {
  const timer = setTimeout(res, 30000);
  const onMsg = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Page.loadEventFired') { clearTimeout(timer); res(); }
  };
  ws.addEventListener('message', onMsg);
});
await new Promise((r) => setTimeout(r, waitMs));

const probe = `(() => {
  const all = Array.from(document.querySelectorAll('*'));
  const ruffle = all.filter((el) => el.tagName && /RUFFLE/i.test(el.tagName));
  const objs = document.querySelectorAll('object, embed');
  const iframes = Array.from(document.querySelectorAll('iframe'))
    .map((f) => f.src || f.getAttribute('data-src') || '')
    .filter(Boolean);
  const txt = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 400);
  return {
    title: document.title,
    href: location.href,
    ruffleElements: ruffle.length,
    ruffleTags: [...new Set(ruffle.map((e) => e.tagName.toLowerCase() + '#' + (e.id || '') + '.' + (e.className || '')))].slice(0, 8),
    ruffleSizes: ruffle.slice(0, 5).map((e) => e.clientWidth + 'x' + e.clientHeight),
    objectEmbedLeft: objs.length,
    objectEmbedSrc: Array.from(objs).slice(0, 5).map((o) => o.getAttribute('data') || o.getAttribute('src') || o.getAttribute('movie') || ''),
    iframes: iframes.slice(0, 8),
    bodyText: txt,
  };
})()`;

const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.result && r.result.result ? r.result.result.value : r, null, 2));

if (shotPath) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(shotPath, Buffer.from(shot.result.data, 'base64'));
    console.log('SHOT -> ' + shotPath);
  } else {
    console.log('截图失败: ' + JSON.stringify(shot));
  }
}

ws.close();
await new Promise((r2) => setTimeout(r2, 200));
