/**
 * smoke-resume.mjs —— R2 场景 4：会话恢复（resume）真实验证
 *
 * 报告 R2 场景 4「会话恢复：重开 session 续聊 → 上下文延续、无碎片」。
 * 零新功能、纯验证：
 *   1. 实例 A：新会话写入事实（幸运数字 42）
 *   2. shutdown 后开实例 B：createAgent(sessionId=同一会话) 续聊
 *   3. 断言 B 记得 A 的事实（会话目录级上下文延续，非进程内缓存）
 *
 * key：优先 DEEPSEEK_API_KEY env，回退 ~/.agent/.env。
 * 用法：node scripts/smoke-resume.mjs
 */

import { createAgent } from '../dist/gateway/factory.js';
import { ProviderManager } from '../dist/provider/manager.js';
import { getProviderConfigLoader } from '../dist/provider/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const envPath = path.join(os.homedir(), '.agent', '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    const m = content.match(/^DEEPSEEK_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* 无 .env 回退 */ }
  return null;
}

const key = loadKey();
if (!key) { console.error('缺少 DEEPSEEK_API_KEY（env 或 ~/.agent/.env）'); process.exit(1); }

getProviderConfigLoader(process.cwd());
const manager = new ProviderManager({ type: 'deepseek', apiKey: key, model: 'deepseek-v4-flash' });
const provider = manager.getProvider();
console.log('[0] provider:', provider.getProviderType(), '/', provider.getModel());

function makeOutputHandler(tag) {
  const texts = [];
  return {
    texts,
    handler: {
      onText: (c) => { texts.push(c); },
      onThinking: () => {},
      onTurnStart: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onDiff: () => {},
      onStatus: (m) => { if (m.startsWith('compress')) console.log(`    [${tag} compress]`, m.slice(0, 60)); },
      onFlush: () => {},
      onInterrupt: () => {},
      onAskUser: () => Promise.resolve('{}'),
    },
  };
}

// ── 实例 A：写入事实 ──
const A = makeOutputHandler('A');
const compA = await createAgent({
  cwd: process.cwd(),
  provider,
  maxTurns: 2,
  maxContext: 20000,
  outputHandler: A.handler,
});
console.log('[1] 实例 A 新会话:', compA.sessionDir);
await compA.loop.run('我的幸运数字是 42，请记住它，回复"记住了"即可');
console.log('    A 回复:', A.texts.join('').trim().slice(0, 60));
try { await compA.loop.shutdown?.(); } catch { /* ignore */ }

// ── 实例 B：resume 同一会话 ──
const sessionId = path.basename(compA.sessionDir);
console.log('[2] shutdown A，用 sessionId resume:', sessionId);
const B = makeOutputHandler('B');
const compB = await createAgent({
  cwd: process.cwd(),
  provider,
  maxTurns: 2,
  maxContext: 20000,
  outputHandler: B.handler,
  sessionId, // resume 同一会话目录
});
await compB.loop.run('我的幸运数字是几？');
const textB = B.texts.join('').trim();
console.log('[3] B 回复:', textB.slice(0, 120));
try { await compB.loop.shutdown?.(); } catch { /* ignore */ }

const pass = textB.includes('42');
console.log(`\n=== R2-4 会话恢复验证: ${pass ? 'PASS' : 'FAIL'}（B 是否记得 42: ${pass}） ===`);
process.exit(pass ? 0 : 1);
