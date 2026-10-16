#!/usr/bin/env node
// ============================================================
// GUI 开发辅助 —— 零依赖 CDP 截图器
// ============================================================
// 为什么要它：MCP 的 take_screenshot 走"返回 base64 → 落盘 → 看图"三步，
// 迭代 UI 时太慢。本脚本一次调用即得图片文件，供 view_media 直接看。
//
// 特性：
//   - 复用常驻 headless Chrome（固定调试端口）⇒ 第二次起约 1 秒出图
//   - 支持 hash 路由（SPA 切页不重载时立即返回，不空等 load）
//   - --eval 可在截图前注入 JS（设置 hash / 开关面板 / 触发动作）
//   - 复用同一 page target ⇒ SPA 状态延续；--fresh 强制新开 target
//
// 用法：
//   node tools-dev/gui/shot.mjs --url "http://127.0.0.1:3100/#/settings" \
//        --out outputs/gui-probe/settings.webp [--w 1600] [--h 960] [--wait 1200] \
//        [--eval "location.hash='#/model'"] [--port 9333] [--fresh]
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function argOf(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const url = argOf('url', 'http://127.0.0.1:3100');
const out = argOf('out', 'outputs/gui-probe/shot.webp');
const W = Number(argOf('w', 1600));
const H = Number(argOf('h', 960));
const waitMs = Number(argOf('wait', 1200));
const port = Number(argOf('port', 9333));
const evalJs = argOf('eval', null);
const fresh = argOf('fresh', false) === true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpJson(pathname, init) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  if (!r.ok) throw new Error(`CDP http ${pathname} -> ${r.status}`);
  return r.json();
}

async function ensureChrome() {
  try {
    return await cdpJson('/json/version');
  } catch { /* 没起，下面启一个 */ }
  const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('Chrome/Edge 未找到；可用 CHROME_PATH 指定');
  const profile = path.join(os.tmpdir(), 'hyacinth-gui-chrome');
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-features=Translate',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    try { return await cdpJson('/json/version'); } catch { /* keep waiting */ }
  }
  throw new Error('Chrome 未在 12s 内暴露 CDP 端口');
}

async function pickTarget() {
  if (fresh) {
    return cdpJson('/json/new?about:blank', { method: 'PUT' });
  }
  const list = await cdpJson('/json/list');
  const page = list.find((t) => t.type === 'page');
  if (page) return page;
  return cdpJson('/json/new?about:blank', { method: 'PUT' });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = [];
    let seq = 0;
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params ?? {} }));
        });
      },
      on(fn) { listeners.push(fn); },
      close() { try { ws.close(); } catch { /* noop */ } },
    });
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message || 'CDP error'));
        else p.res(m.result);
      } else {
        for (const fn of listeners) fn(m);
      }
    };
  });
}

async function main() {
  const ver = await ensureChrome();
  const target = await pickTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // 必须禁缓存 + 先落空白页：改了 index.html / app.js 后，若目标 URL（含 hash）
  // 与当前页相同，Page.navigate 会被当成 same-document 跳转 ⇒ **根本不重新加载**，
  // 拿到的是旧页面（2026-10-16 实测踩过：新加的 DOM 节点全部读成 null）。
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await cdp.send('Page.navigate', { url });

  // 轮询 readyState：hash 变化时 SPA 已 complete ⇒ 立即通过，不空等 load 事件
  for (let i = 0; i < 80; i++) {
    await sleep(120);
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r?.result?.value === 'complete') break;
    } catch { /* 导航中，重试 */ }
  }
  await sleep(waitMs);

  if (typeof evalJs === 'string') {
    const r = await cdp.send('Runtime.evaluate', {
      expression: evalJs, awaitPromise: true, returnByValue: true,
    });
    const val = r?.result?.value;
    if (val !== undefined) console.log('[eval]', JSON.stringify(val).slice(0, 400));
    await sleep(400);
  }

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'webp', quality: 82, captureBeyondViewport: false,
  });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`shot -> ${out} (${fs.statSync(out).size} bytes) ${W}x${H} | ${url} | chrome ${ver?.Browser ?? '?'}`);
  cdp.close();
}

main().catch((e) => {
  console.error('shot failed:', e.message);
  process.exit(1);
});
