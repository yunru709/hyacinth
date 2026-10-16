#!/usr/bin/env node
/**
 * 探查运行中后端对「陪伴是否激活」的判定（2026-10-16）
 *
 * 背景：桌面壳首页主区显示「陪伴会话进行中」，但 config.startup.defaultMode = normal
 * ⇒ 需确认是后端真报 active，还是前端另有置位路径。
 *
 * 用法: node tools-dev/gui/probe-companion-state.mjs [--port 3130]
 */
const port = (() => { const i = process.argv.indexOf('--port'); return i >= 0 ? process.argv[i + 1] : '3130'; })();

const pending = new Map();
let ws;
let seq = 0;

function send(method, params) {
  const id = 'p' + (++seq);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 8000);
  });
}

const main = async () => {
  ws = new WebSocket('ws://127.0.0.1:' + port + '/ui');
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('连接超时')), 8000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('WS error')); });
  });

  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.kind === 'response' && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      p.resolve(m);
    }
    if (m.kind === 'event' && m.type !== 'message.text' && m.type !== 'state.update') {
      console.log('  [event] ' + m.type + ' ' + JSON.stringify(m.payload || {}).slice(0, 160));
    }
  });

  // 等握手
  await new Promise((r) => setTimeout(r, 800));

  console.log('=== companion.get（后端判定）===');
  const cg = await send('companion.get');
  console.log('  ' + JSON.stringify(cg.result || cg.error));

  console.log('=== session.list（前 8 个会话及其 type）===');
  try {
    const sl = await send('session.list');
    const list = (sl.result && (sl.result.sessions || sl.result.list || sl.result)) || [];
    const arr = Array.isArray(list) ? list : [];
    arr.slice(0, 8).forEach((s) => console.log('  ' + JSON.stringify({ id: s.id || s.sessionId, type: s.type, title: s.title }).slice(0, 160)));
    console.log('  共 ' + arr.length + ' 个');
  } catch (e) { console.log('  ' + e.message); }

  console.log('=== state.subscribe（快照，看 session/mode 字段）===');
  const ss = await send('state.subscribe');
  console.log('  ' + JSON.stringify(ss.result || ss.error).slice(0, 500));

  try { ws.close(); } catch { /* ignore */ }
  process.exit(0);
};

main().catch((e) => { console.error('探针失败: ' + e.message); process.exit(2); });
