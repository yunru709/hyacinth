#!/usr/bin/env node
/**
 * probe-config-get.mjs —— 定位 config.get 超时（2026-10-25）
 *
 * 背景：probe-config-persist 里 config.set 有响应、config.get 超时。
 * 同一连接、同一消息格式 ⇒ 差异只可能来自 method 实现或响应构造。
 * 本探针分别打 getAll / get(path) 各两次，把「有没有响应」与「响应长啥样」分开。
 */
const PORT = Number(process.argv[2] ?? 4310);
const TOKEN = process.argv[3] ?? 'devkey';

const pending = new Map();
let seq = 0;

function call(ws, method, params, timeoutMs = 6000) {
  const id = `g${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ timeout: true, id, method });
      }
    }, timeoutMs);
  });
}

const cases = [
  ['config.getAll', undefined],
  ['config.get', { path: 'stt.enabled' }],
  ['config.get', { path: 'voice.say.broadcast' }],
  ['state.get', undefined],
];

async function main() {
  const url = `ws://127.0.0.1:${PORT}/ui?token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    setTimeout(() => rej(new Error('connect timeout')), 8000);
  });

  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    // 打印所有非 event 消息的骨架，便于发现 id/shape 不匹配
    if (m.kind !== 'event') {
      console.log('  ← 收到', m.kind, 'id=' + m.id, 'ok=' + m.ok);
    }
    const r = pending.get(m.id);
    if (r) {
      pending.delete(m.id);
      r(m);
    }
  });

  for (const [method, params] of cases) {
    const label = `${method}${params ? ' ' + JSON.stringify(params) : ''}`;
    process.stdout.write(`\n→ ${label}\n`);
    const r = await call(ws, method, params);
    if (r.timeout) {
      console.log('  ✗ 无响应（timeout）');
    } else {
      const body = JSON.stringify(r.result ?? r.error ?? null);
      console.log('  ✓', body.slice(0, 220));
    }
  }
  ws.close();
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
