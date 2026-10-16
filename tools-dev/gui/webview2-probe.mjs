#!/usr/bin/env node
/**
 * 探查 WebView2 内部的真实情况（console / 异常 / WebSocket 帧）。
 *
 * 为什么需要它：桌面壳里的 WebView2 是**黑盒** —— 页面为什么"离线"、
 * WS 为什么连不上，从外面（后端日志 / 进程状态 / 截屏）都看不出来。
 * 壳带上 `--remote-debugging-port=9222` 后，本脚本用 CDP 进去看。
 * （纪律：踩过的坑 —— 「进程活着」「端口 200」都不等于「页面连上了」。）
 *
 * 用法：
 *   node tools-dev/gui/webview2-probe.mjs [--port 9222] [--seconds 10] [--shot out.png]
 * 零依赖：只用 Node 内置 fetch 与 WebSocket（Node ≥ 22）。
 */
import fs from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const port = Number(arg('port', '9222'));
const seconds = Number(arg('seconds', '10'));
const shotPath = arg('shot', null);
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`${base}/json/list`);
  return res.json();
}

/** 极简 CDP 客户端（够用即可，不引依赖） */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('WS 连接失败: ' + (e.message || e.type))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 15000);
    });
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

const main = async () => {
  let targets;
  try {
    targets = await listTargets();
  } catch (e) {
    console.error(`✗ 连不上 CDP :${port} —— 壳是否带 --remote-debugging-port？(${e.message})`);
    process.exit(2);
  }

  console.log(`=== CDP 目标（共 ${targets.length}）===`);
  for (const t of targets) console.log(`  [${t.type}] ${t.title}  ${t.url}`);

  const page = targets.find((t) => t.type === 'page')
    || targets.find((t) => (t.url || '').startsWith('http'))
    || targets[0];
  if (!page) { console.error('✗ 没有可用 target'); process.exit(3); }
  console.log(`\n=== 探查目标 ===\n  ${page.title} | ${page.url}\n`);

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;

  const consoleMsgs = [];
  const exceptions = [];
  const logs = [];
  const wsEvents = [];
  const failedReqs = [];

  cdp.on((msg) => {
    const { method, params } = msg;
    if (method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push(`[${params.type}] ` + params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      exceptions.push(`${d.text} ${d.exception?.description || ''}`.slice(0, 400));
    } else if (method === 'Log.entryAdded') {
      logs.push(`[${params.entry.level}] ${params.entry.text}`.slice(0, 300));
    } else if (method?.startsWith('Network.webSocket')) {
      const extra = params.errorMessage ? ` err=${params.errorMessage}` : (params.response?.status ? ` status=${params.response.status}` : '');
      wsEvents.push(`${method.replace('Network.', '')} ${params.url || ''}${extra}`);
    } else if (method === 'Network.loadingFailed') {
      failedReqs.push(`${params.type} ${params.errorText}`.slice(0, 200));
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  // 立刻探一下当前页面的连接状态（app.js 会暴露什么就用什么）
  try {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('#conn-status, .conn-status, [data-conn]');
        return JSON.stringify({
          href: location.href,
          readyState: document.readyState,
          connText: el ? el.textContent.trim() : null,
          connClass: el ? el.className : null,
          hasClient: typeof window.client !== 'undefined',
        });
      })()`,
      returnByValue: true,
    });
    console.log('=== 页面即时状态 ===\n' + probe.result.value + '\n');
  } catch (e) {
    console.log('即时状态探测失败: ' + e.message + '\n');
  }

  console.log(`=== 观察 ${seconds}s ===`);
  await sleep(seconds * 1000);

  const dump = (title, arr) => {
    console.log(`\n--- ${title}（${arr.length}）---`);
    arr.slice(-25).forEach((l) => console.log('  ' + l));
  };
  dump('console 输出', consoleMsgs);
  dump('未捕获异常', exceptions);
  dump('Log 条目', logs);
  dump('WebSocket 事件', wsEvents);
  dump('加载失败', failedReqs);

  if (shotPath) {
    try {
      const img = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shotPath, Buffer.from(img.data, 'base64'));
      console.log(`\n截图已保存 -> ${shotPath}`);
    } catch (e) {
      console.log('\n截图失败: ' + e.message);
    }
  }

  cdp.close();
};

main().catch((e) => { console.error('探针异常: ' + e.message); process.exit(1); });
