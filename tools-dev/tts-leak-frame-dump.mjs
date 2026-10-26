/**
 * 定位泄漏帧：把所有**接收帧**（后端→前端）里含哨兵的挑出来，并打印上下文。
 * 目的：确认是哪条协议/事件把密钥明文送到了前端。
 *
 * 用法：node tools-dev/tts-leak-frame-dump.mjs [cdpPort] [webPort]
 */
const CDP_PORT = Number(process.argv[2] || 9333);
const WEB_PORT = Number(process.argv[3] || 3100);
const SENTINEL = 'SENTINEL_DUMP_CANARY_b4e7';

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('❌ 找不到 page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const send = (method, params) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

const recv = [];
ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.webSocketFrameReceived') recv.push(String(m.params?.response?.payloadData ?? ''));
});

await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', () => j(new Error('CDP WS 失败')));
});
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/#/settings` });
await new Promise((r) => setTimeout(r, 3500));

await send('Runtime.evaluate', {
  expression: `(async()=>{
    const t=document.querySelector('#tab-voice'); if(t) t.click();
    await new Promise(r=>setTimeout(r,900));
    const s=document.querySelector('#tts-engine');
    if(s && s.value!=='online'){ s.value='online'; s.dispatchEvent(new Event('change',{bubbles:true})); }
    await new Promise(r=>setTimeout(r,1500));
    const inp=document.querySelector('#tts-online-apikey');
    const btn=document.querySelector('#tts-online-save');
    if(!inp||!btn) return 'NO_FORM';
    inp.value=${JSON.stringify(SENTINEL)};
    btn.click();
    await new Promise(r=>setTimeout(r,2500));
    return 'DONE';
  })()`,
  awaitPromise: true, returnByValue: true,
});

const hits = recv.filter((f) => f.includes(SENTINEL));
console.log(`接收帧 ${recv.length} 条，含哨兵 ${hits.length} 条：\n`);
for (const h of hits) {
  console.log('──────── 泄漏帧 ────────');
  console.log(h.slice(0, 900));
  console.log('');
}

// 收尾：用「清除」按钮删密钥。
// ⚠️ 不能"清空输入框再点保存"：前端约定「空 = 不修改」，那样等于没清
// （实测把哨兵留在了用户 config.json 里，事后还得手写脚本修回来）。
await send('Runtime.evaluate', {
  expression: `(async()=>{const c=document.querySelector('#tts-online-apikey-clear'); if(!c) return 'NO_BTN'; c.click(); await new Promise(r=>setTimeout(r,1800)); return 'CLEARED';})()`,
  awaitPromise: true, returnByValue: true,
});
ws.close();
process.exit(hits.length ? 1 : 0);
