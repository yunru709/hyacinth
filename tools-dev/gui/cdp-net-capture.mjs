#!/usr/bin/env node
/**
 * 抓页面真实发起的 .swf 请求 —— 零依赖 CDP（Network 域）
 *
 * 为什么要抓包：4399 页面里给的 `_strGamePath` 是相对路径，直接拼域名会 404；
 * 真正的地址由页面 JS / Ruffle 扩展请求出来，只有监听 Network 才拿得到（别猜）。
 *
 * 用法: node tools-dev/gui/cdp-net-capture.mjs <url> [waitMs]
 * 端口: CDP_PORT 环境变量（默认 9224）
 * 输出: 每个 swf 请求的 状态码 / 类型 / 字节数 / URL
 */
const port = process.env.CDP_PORT || 9224;
const url = process.argv[2];
const waitMs = Number(process.argv[3] || 25000);
if (!url) {
  console.error('用法: node tools-dev/gui/cdp-net-capture.mjs <url> [waitMs]');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('  ❌ 找不到 page target');
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

const reqs = new Map();   // requestId -> {url, type}
const done = [];          // 已完成的响应
ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    reqs.set(m.params.requestId, { url: r.url, type: m.params.type, method: r.method });
  } else if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    const prev = reqs.get(m.params.requestId) || {};
    done.push({ url: r.url, status: r.status, mime: r.mimeType, fromDiskCache: r.fromDiskCache, type: prev.type });
  } else if (m.method === 'Network.loadingFinished') {
    const prev = reqs.get(m.params.requestId);
    if (prev) prev.bytes = m.params.encodedDataLength;
  }
});

await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', () => j(new Error('CDP WS 连接失败')));
});

await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, waitMs));

const isSwf = (u) => /\.swf(\?|$)/i.test(u);
console.log('=== 所有 .swf 请求 ===');
const swfReqs = done.filter((d) => isSwf(d.url));
if (!swfReqs.length) console.log('  （没有捕获到 .swf 请求）');
for (const d of swfReqs) {
  console.log(`  [${d.status}] ${d.mime}  ${d.bytes ?? '?'}B  ${d.url}`);
}
console.log('\n=== 所有 XHR/fetch 且非静态资源（可能藏着 loader 地址）===');
const others = done.filter((d) => !isSwf(d.url) && /json|javascript|xml|text/i.test(d.mime || '') && !/\.(js|css|png|jpg|gif)/i.test(d.url));
for (const d of others.slice(0, 25)) {
  console.log(`  [${d.status}] ${d.mime}  ${d.url.slice(0, 160)}`);
}
console.log('\n=== 各请求类型计数 ===');
const counts = {};
for (const d of done) counts[d.type || '?'] = (counts[d.type || '?'] || 0) + 1;
console.log('  ' + JSON.stringify(counts));

ws.close();
await new Promise((r) => setTimeout(r, 200));
