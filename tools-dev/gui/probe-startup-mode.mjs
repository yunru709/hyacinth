#!/usr/bin/env node
/**
 * 桌面壳「启动即陪伴模式」取证探针（2026-10-16）
 *
 * 一次拿齐三方事实，避免靠读代码推断：
 *   ① 后端：config.get startup.defaultMode / ② companion.get / ③ 当前会话 type
 *   ④ 页面（CDP）：location.hash / localStorage.startupMode / companionActive 痕迹
 *
 * 用法: node tools-dev/gui/probe-startup-mode.mjs [--port 3130] [--cdp 9222]
 */
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; };
const port = arg('port', '3130');
const cdpPort = arg('cdp', '9222');

// ---------- 后端（WS 协议）----------
async function askBackend() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`);
  const pending = new Map();
  let seq = 0;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('WS 连接超时')), 8000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('WS error')); });
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.kind === 'response' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
  });
  const send = (method, params) => new Promise((res) => {
    const id = 'q' + (++seq);
    pending.set(id, res);
    ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: method + ' 超时' } }); } }, 7000);
  });
  await new Promise((r) => setTimeout(r, 700));

  const out = {};
  out.defaultMode = await send('config.get', { path: 'startup.defaultMode' });
  out.companionGet = await send('companion.get');
  out.sessionList = await send('session.list');
  try { ws.close(); } catch { /* ignore */ }
  return out;
}

// ---------- 页面（CDP）----------
async function askPage() {
  let targets;
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    targets = await r.json();
  } catch (e) {
    return { error: 'CDP 不可达(' + cdpPort + '): ' + e.message };
  }
  const page = (targets || []).find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url || ''));
  if (!page) return { error: '未找到页面 target', targets: (targets || []).map((t) => ({ type: t.type, url: t.url })) };

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP WS 超时')), 8000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('CDP WS error')); });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
  });
  const evaluate = (expr) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: 'eval 超时' } }); } }, 7000);
  });

  const probe = await evaluate(`JSON.stringify({
    hash: location.hash,
    href: location.href,
    startupMode: (function(){ try { return localStorage.getItem('hyacinth.startupMode'); } catch(e){ return 'ERR:'+e.message; } })(),
    theme: (function(){ try { return localStorage.getItem('hyacinth.theme'); } catch(e){ return null; } })(),
    hasApi: !!window.__hyacinth
  })`);
  try { ws.close(); } catch { /* ignore */ }
  return { url: page.url, raw: probe.result && probe.result.result && probe.result.result.value, err: probe.error };
}

const main = async () => {
  console.log('=== ① 后端（ws://127.0.0.1:' + port + '/ui）===');
  try {
    const b = await askBackend();
    console.log('  config.get startup.defaultMode = ' + JSON.stringify((b.defaultMode.result || b.defaultMode.error)));
    console.log('  companion.get = ' + JSON.stringify(b.companionGet.result || b.companionGet.error));
    const sl = b.sessionList.result;
    if (sl) {
      const arr = Array.isArray(sl) ? sl : (sl.sessions || sl.list || []);
      console.log('  session 数 = ' + (Array.isArray(arr) ? arr.length : 'n/a'));
      if (Array.isArray(arr)) arr.slice(0, 6).forEach((s) => console.log('    ' + JSON.stringify({ id: s.id || s.sessionId, type: s.type }).slice(0, 140)));
    } else {
      console.log('  session.list = ' + JSON.stringify(b.sessionList.error));
    }
  } catch (e) { console.log('  后端不可达: ' + e.message); }

  console.log('');
  console.log('=== ② 页面（CDP :' + cdpPort + '）===');
  const p = await askPage();
  if (p.error) console.log('  ' + p.error);
  else {
    console.log('  url = ' + p.url);
    console.log('  eval = ' + p.raw);
    if (p.err) console.log('  evalErr = ' + JSON.stringify(p.err));
  }
  // 等 WS 句柄关干净再退出：否则 Windows 上 Node 会打
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"（无害，但看着像崩了）
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
};

main().catch((e) => { console.error('探针失败: ' + e.message); process.exit(2); });
