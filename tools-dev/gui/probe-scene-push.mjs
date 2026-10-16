#!/usr/bin/env node
/**
 * 陪伴场景推送 e2e 探针（2026-10-16）
 *
 * 验的是**真实链路**，不是单测里的替身：
 *   连真实后端 WS /ui → 收到 ui.connected →
 *   在真实场景目录写 scene.json →
 *   断言收到 companion.scene 事件（且角色名对得上）。
 *
 * 用法：node tools-dev/gui/probe-scene-push.mjs [--port 3130]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? process.argv[i + 1] : '3130';
})();

const CHARACTER = '__probe_character__';
const sceneDir = path.join(os.homedir(), '.agent', 'companion', CHARACTER);

const log = (...a) => console.log(...a);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`);
    const events = [];
    const timer = setTimeout(() => reject(new Error('WS 超时（未收到 ui.connected）')), 10000);
    ws.addEventListener('open', () => log('  WS 已建立'));
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.kind === 'event') {
        events.push({ type: m.type, payload: m.payload });
        log('  事件: ' + m.type + (m.payload ? ' ' + JSON.stringify(m.payload).slice(0, 120) : ''));
        if (m.type === 'ui.connected') {
          clearTimeout(timer);
          resolve({ ws, events });
        }
      }
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('WS error: ' + (e.message || e.type))); });
  });
}

const main = async () => {
  log('=== 1) 连接真实后端 ws://127.0.0.1:' + port + '/ui ===');
  const { ws, events } = await connect();

  log('=== 2) 清理上次探针残留 ===');
  fs.rmSync(sceneDir, { recursive: true, force: true });

  log('=== 3) 等 1s（让 watcher 就绪）===');
  await new Promise((r) => setTimeout(r, 1000));

  log('=== 4) 写 scene.json（模拟 scene_render 落盘）===');
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(
    path.join(sceneDir, 'scene.json'),
    JSON.stringify({ signature: 'probe-sig-' + Date.now(), prompt: '探针场景', provider: 'probe', createdAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  log('  已写: ' + path.join(sceneDir, 'scene.json'));

  log('=== 5) 等 3s 收推送 ===');
  await new Promise((r) => setTimeout(r, 3000));

  const hit = events.find((e) => e.type === 'companion.scene');
  log('');
  log('=== 结论 ===');
  if (hit) {
    log('  ✅ 收到 companion.scene 推送: ' + JSON.stringify(hit.payload));
    const gotCh = hit.payload && hit.payload.character;
    log('  角色名匹配: ' + (gotCh === CHARACTER ? '✅ ' + gotCh : '❌ 期望 ' + CHARACTER + ' 实得 ' + String(gotCh)));
  } else {
    log('  ❌ 未收到 companion.scene —— 推送链路未生效');
    log('  收到的事件：' + events.map((e) => e.type).join(', '));
  }

  log('=== 6) 清理 ===');
  fs.rmSync(sceneDir, { recursive: true, force: true });
  try { ws.close(); } catch { /* ignore */ }
  process.exit(hit ? 0 : 1);
};

main().catch((e) => { console.error('探针失败: ' + e.message); process.exit(2); });
