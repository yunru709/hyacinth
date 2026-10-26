/**
 * 密钥不泄漏 —— CDP 抓页面真实 WS 帧，区分方向取证。
 *
 * 为什么不自己发 WS：我按 {kind,id,method,params} 发帧收不到响应（探针问题，原因未查清），
 * 而页面自己走这条路是通的。监听浏览器 WS 帧 = "密钥有没有到前端"的权威证据。
 *
 * ⚠️ 判据必须分方向：
 *   - **发送帧（UI→后端）**：用户点保存时密钥必然出现在这里 —— 这是正常的，不算泄漏。
 *   - **接收帧（后端→UI）**：这才是泄漏面。密钥一旦出现，就等于到了 DOM/内存/devtools。
 * 上一版把两个方向混在一起判，会得出"必然泄漏"的假结论。
 *
 * 流程（走的正是用户真实路径）：页面填密钥 → 点保存 → 后端写配置 → 页面重新拉 onlineConfig
 *   → 检查接收帧里有没有那个密钥。
 *
 * 用法：node tools-dev/tts-online-key-leak-cdp.mjs [cdpPort] [webPort]
 */
const CDP_PORT = Number(process.argv[2] || 9333);
const WEB_PORT = Number(process.argv[3] || 3100);
const SENTINEL = 'SENTINEL_LEAK_CANARY_7f2b91';

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

const recvFrames = [];
const sentFrames = [];
ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  const p = String(m.params?.response?.payloadData ?? '');
  if (m.method === 'Network.webSocketFrameReceived') recvFrames.push(p);
  if (m.method === 'Network.webSocketFrameSent') sentFrames.push(p);
});

await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', () => j(new Error('CDP WS 失败')));
});

await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/#/settings` });
await new Promise((r) => setTimeout(r, 3500));

const r = await send('Runtime.evaluate', {
  expression: `(async()=>{
    const t=document.querySelector('#tab-voice'); if(t) t.click();
    await new Promise(r=>setTimeout(r,900));
    const s=document.querySelector('#tts-engine');
    if(!s) return 'NO_SEL';
    if(s.value!=='online'){ s.value='online'; s.dispatchEvent(new Event('change',{bubbles:true})); }
    await new Promise(r=>setTimeout(r,1500));
    const inp=document.querySelector('#tts-online-apikey');
    const btn=document.querySelector('#tts-online-save');
    if(!inp||!btn) return 'NO_FORM inp='+!!inp+' btn='+!!btn;
    inp.value=${JSON.stringify(SENTINEL)};
    btn.click();
    await new Promise(r=>setTimeout(r,2500));
    const st=document.querySelector('#tts-online-key-state');
    return JSON.stringify({
      engine: document.querySelector('#tts-engine').value,
      keyState: st?st.textContent:null,
      apikeyInputAfter: inp.value,
      blockHidden: document.querySelector('#tts-online-block').hidden,
    });
  })()`,
  awaitPromise: true, returnByValue: true,
});
console.log('[page 状态]', r.result?.result?.value ?? JSON.stringify(r.result));

const recvAll = recvFrames.join('\n');
const onlineResp = recvFrames.find((f) => f.includes('hasApiKey'));

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) fail++; };

console.log(`\n帧数：收到 ${recvFrames.length} / 发出 ${sentFrames.length}`);
if (onlineResp) console.log(`onlineConfig 接收帧 = ${onlineResp.slice(0, 500)}`);

check(sentFrames.join('\n').includes(SENTINEL), '发送帧里出现密钥（保存动作确实执行了 —— 这是正常方向）');
check(!!onlineResp, '抓到了 tts.onlineConfig 的接收帧（证明这条链路真的跑了）');
check(!recvAll.includes(SENTINEL), recvAll.includes(SENTINEL) ? '❌❌ 后端把密钥明文回传了 = 泄漏' : '后端未把密钥回传给前端（接收帧里无哨兵）');
check(/hasApiKey"\s*:\s*true/.test(recvAll), 'hasApiKey=true（密钥确实写进配置了）');
check(recvAll.includes('"apiKeySource"'), '响应带 apiKeySource（来源可辨）');

// 收尾：把密钥清掉
await send('Runtime.evaluate', {
  expression: `(async()=>{const inp=document.querySelector('#tts-online-apikey'); const btn=document.querySelector('#tts-online-save'); if(!inp||!btn) return 'NO'; inp.value=''; btn.click(); await new Promise(r=>setTimeout(r,1500)); return 'CLEARED';})()`,
  awaitPromise: true, returnByValue: true,
});

ws.close();
console.log(fail === 0 ? '\n✅ 密钥不泄漏（真实页面 WS 接收帧取证）' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
