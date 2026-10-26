/**
 * 行为验证：**切换引擎时，旧的真的被释放、新的真的被拉起吗？**
 *
 * 【为什么必须实测】上一轮只做到「配置改了、实例换了」，但旧引擎的子进程没人停
 * —— 2026-10-26 实测 cosyvoice(Python 3.7GB) 与 breeze(常驻 3.7GB) 同驻 8GB 卡
 * 达 7167/8188 MiB。本次新增 dispose/warmup + switchTtsEngine，本探针就是它的证据：
 *   · 切走时：旧引擎的端口必须关掉（进程被带走）
 *   · 切来时：新引擎的端口必须起来（进程被拉起）
 *
 * 用 breeze ↔ online 两跳验证机制本身（online 无本地进程，切它等于"只释放不拉起"），
 * 全程不碰 cosyvoice 的 Python（那个要 40s+，且模型可能缺）。
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const { switchTtsEngine, resetTtsEngine } = await import('../dist/tts/index.js');
const { breezeServerState } = await import('../dist/tts/engines/breeze-server.js');

const BREEZE_PORT = 8189;
let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failed++;
};

function portOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const fin = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
    sock.once('timeout', () => fin(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function waitPort(port, want, deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if ((await portOpen(port)) === want) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ── 读真实 config.json（扁平化成 dot-path 读取器）───────────────
const cfgPath = path.join(os.homedir(), '.agent', 'config.json');
const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const flat = new Map();
(function walk(o, p) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
    else flat.set(key, v);
  }
})(raw, '');
const reader = { get: (k) => flat.get(k) };
// 只改内存副本，**绝不写盘**（用户的 config.json 不能被探针污染）
const setCfg = (k, v) => flat.set(k, v);

console.log(`初始配置 engine = ${reader.get('voice.tts.engine')}`);

// ── ① 基点：先确保 8189 是关的 ────────────────────────────────
resetTtsEngine();
if (await portOpen(BREEZE_PORT)) {
  console.log('⚠ 8189 起初就开着（上一轮残留？先记下，后续判据仍成立）');
}

// ── ② 切到 breeze：应当**拉起**常驻 server ──────────────────────
console.log('\n=== ② 切到 breeze-tts-2（期望拉起 8189）===');
setCfg('voice.tts.engine', 'breeze-tts-2');
const a = switchTtsEngine(reader);
check(a.to === 'breeze-tts-2', `switchTtsEngine → ${a.to}`);
const up = await waitPort(BREEZE_PORT, true, 60000);
check(up, `8189 在 60s 内起来（${JSON.stringify(breezeServerState())}）`);

// ── ③ 切到 online：应当**释放** breeze（8189 关闭）──────────────
console.log('\n=== ③ 切到 online（期望释放 8189）===');
setCfg('voice.tts.engine', 'online');
setCfg('voice.tts.online.provider', 'breeze');
const b = switchTtsEngine(reader);
check(b.to !== 'breeze-tts-2' || b.from !== b.to, `切到 ${b.to}（from=${b.from}）`);
const down = await waitPort(BREEZE_PORT, false, 20000);
check(down, `8189 已关闭 ⇒ breeze 常驻进程被 dispose 带走`);
check(!breezeServerState().running, `breezeServerState().running = ${breezeServerState().running}`);

// ── ④ 切回 breeze：应当再次拉起 ────────────────────────────────
console.log('\n=== ④ 切回 breeze-tts-2（期望再次拉起 8189）===');
setCfg('voice.tts.engine', 'breeze-tts-2');
const c = switchTtsEngine(reader);
check(c.to === 'breeze-tts-2', `switchTtsEngine → ${c.to}`);
const up2 = await waitPort(BREEZE_PORT, true, 60000);
check(up2, `8189 再次起来（${JSON.stringify(breezeServerState())}）`);

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
process.exit(failed ? 1 : 0);
