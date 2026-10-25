#!/usr/bin/env node
/**
 * probe-config-persist.mjs —— 向运行实例取证：config.set 到底有没有落盘（2026-10-25）
 *
 * 为什么需要它：代码里 `config.set` → `maybePersist` → `save.call(center)` 看着是通的，
 * 但"看着通"不算证据（纪律：行为类结论一律向运行实例取证，别读代码推断）。
 * 本探针连 webui 的 /ui 端点，读现值 → 改成相反值 → 再读磁盘 config.json，
 * 三者对比即可判定落盘链路是否真的work，最后恢复原值。
 *
 * 用法：node tools-dev/probe-config-persist.mjs [port] [path]
 *   默认 port=4310（webui），path=stt.enabled
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.argv[2] ?? 4310);
const CFG_PATH = process.argv[3] ?? 'stt.enabled';
const CONFIG_FILE = path.join(os.homedir(), '.agent', 'config.json');

function readDisk(keyPath) {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return keyPath.split('.').reduce((o, k) => (o == null ? o : o[k]), j);
  } catch (e) {
    return `<读取失败: ${e.message}>`;
  }
}

function diskMtime() {
  try {
    return fs.statSync(CONFIG_FILE).mtime.toISOString();
  } catch {
    return '<无>';
  }
}

const pending = new Map();
let seq = 0;

function request(ws, method, params) {
  const id = `probe_${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 8000);
  });
}

async function main() {
  console.log(`config.json: ${CONFIG_FILE}`);
  console.log(`磁盘现值 ${CFG_PATH} =`, JSON.stringify(readDisk(CFG_PATH)), `│ mtime=${diskMtime()}`);

  // /ui 的 WS 升级走鉴权（http-webhook.ts:149）⇒ 必须带 ?token=<api-key>，
  // webui 启动时用的是 `--api-key devkey`，故默认 devkey。
  const token = process.argv[4] ?? process.env.WEBUI_TOKEN ?? 'devkey';
  const url = `ws://127.0.0.1:${PORT}/ui?token=${encodeURIComponent(token)}`;
  console.log(`\n连接 ${url} ...`);

  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error（端口/协议不对？）')), { once: true });
    setTimeout(() => rej(new Error('ws connect timeout')), 8000);
  });
  console.log('已连接 ✓');

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.kind === 'response' && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  // 1) 读后端当前值
  let current;
  try {
    const r = await request(ws, 'config.get', { path: CFG_PATH });
    current = r.ok ? r.result?.value ?? r.result : undefined;
    console.log(`后端 config.get →`, JSON.stringify(r.result ?? r.error));
  } catch (e) {
    console.log(`config.get 失败: ${e.message}`);
  }

  const target = typeof current === 'boolean' ? !current : true;
  console.log(`\n写入相反值 ${CFG_PATH} = ${JSON.stringify(target)} ...`);
  try {
    const r = await request(ws, 'config.set', { path: CFG_PATH, value: target });
    console.log(`config.set → ok=${r.ok}`, JSON.stringify(r.result ?? r.error));
  } catch (e) {
    console.log(`config.set 失败: ${e.message}`);
  }

  // 等持久化落盘（save 是异步的）
  await new Promise((r) => setTimeout(r, 1200));

  const after = readDisk(CFG_PATH);
  const mtimeAfter = diskMtime();
  console.log(`\n磁盘复查 ${CFG_PATH} =`, JSON.stringify(after), `│ mtime=${mtimeAfter}`);
  const persisted = after === target;
  console.log(persisted ? '✅ 已落盘：config.set → config.json 链路通' : '❌ 未落盘：config.json 没有跟着变');

  // 恢复原值
  if (current !== undefined) {
    console.log(`\n恢复原值 ${CFG_PATH} = ${JSON.stringify(current)} ...`);
    try {
      await request(ws, 'config.set', { path: CFG_PATH, value: current });
      await new Promise((r) => setTimeout(r, 1200));
      console.log(`恢复后磁盘 =`, JSON.stringify(readDisk(CFG_PATH)));
    } catch (e) {
      console.log(`恢复失败: ${e.message}`);
    }
  }

  ws.close();
}

main().catch((e) => {
  console.error('探针失败:', e.message);
  process.exit(1);
});
