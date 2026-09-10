/**
 * smoke-compress-natural.mjs —— R3 观测：压缩 token 回落（真实对话形态）
 *
 * 上轮 smoke-compress 用「重复长文 + 3 字回复」人造输入，压缩后 token 未净回落
 * （9516→9831，compress 省量被每轮新增 1341 token 输入淹没 + protect 保护）。
 * 本脚本换**自然多轮问答**（用户提问 + agent 展开长答），验证真实对话形态下
 * 压缩是否让上下文 token 实质回落（Y < X 或 stats current_context_tokens 下降）。
 *
 * key：优先 DEEPSEEK_API_KEY env，回退 ~/.agent/.env。
 * 用法：node scripts/smoke-compress-natural.mjs
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
if (!key) { console.error('缺少 DEEPSEEK_API_KEY'); process.exit(1); }

getProviderConfigLoader(process.cwd());
const manager = new ProviderManager({ type: 'deepseek', apiKey: key, model: 'deepseek-v4-flash' });
const provider = manager.getProvider();
console.log('[0] provider:', provider.getProviderType(), '/', provider.getModel());

const statusEvents = [];
const textChunks = [];
const outputHandler = {
  onText: (c) => { textChunks.push(c); },
  onThinking: () => {},
  onTurnStart: () => {},
  onToolUse: () => {},
  onToolResult: () => {},
  onDiff: () => {},
  onStatus: (msg, lvl) => { statusEvents.push({ msg, lvl }); },
  onFlush: () => {},
  onInterrupt: () => {},
  onAskUser: () => Promise.resolve('{}'),
};

const TARGET_CTX = 5_000; // 阈值 0.75 × 5000 = 3750
const comp = await createAgent({
  cwd: process.cwd(),
  provider,
  maxTurns: 2,
  maxContext: TARGET_CTX,
  outputHandler,
});
comp.loop.configCenter?.set('session.maxContext', TARGET_CTX);
comp.loop.maxContextTokens = TARGET_CTX;
comp.loop.stageServices?.set('maxContextTokens', TARGET_CTX);
console.log('[1] patched maxContextTokens →', TARGET_CTX, '（压缩阈值 =', Math.floor(TARGET_CTX * 0.75) + '）');

// 自然问答序列：每轮真实问题 + 要求展开详答（agent 回复长 → 历史含大量可摘要内容）
const QUESTIONS = [
  '请详细解释 Raft 共识算法的领导者选举机制，要求 200 字以上。',
  'Paxos 与 Raft 相比核心区别是什么？为什么 Raft 更易工程实现？请 200 字以上。',
  'CAP 定理的三个约束分别指什么？请举例说明分布式系统如何取舍，200 字以上。',
  '请解释最终一致性、顺序一致性与线性一致性的区别，各举一个适用场景，200 字以上。',
  '什么是两阶段提交（2PC）？它有什么缺陷？3PC 如何改进？200 字以上。',
  '分布式事务有哪些主流方案？SAGA 模式的补偿机制如何工作？200 字以上。',
  '什么是事件溯源（Event Sourcing）？它与 CQRS 如何配合？200 字以上。',
  '请解释服务网格（Service Mesh）的 Sidecar 模式原理与优缺点，200 字以上。',
];

let sawCompressResult = false;
let compressDelta = null;
for (let i = 0; i < QUESTIONS.length; i++) {
  textChunks.length = 0;
  statusEvents.length = 0;
  console.log(`\n[2] Q${i + 1}/${QUESTIONS.length}: ${QUESTIONS[i].slice(0, 40)}...`);
  await comp.loop.run(QUESTIONS[i]);
  const reply = textChunks.join('').trim();
  console.log(`    A(${reply.length}字): ${reply.slice(0, 50)}...`);

  for (const e of statusEvents) {
    if (e.msg.startsWith('compress-result:')) {
      const [pre, post] = e.msg.split(':').slice(1).map(Number);
      console.log(`    [compress-result] ${pre} → ${post} (${post >= pre ? '未回落 ▲' : '回落 ▼'} ${Math.abs(post - pre)} tokens)`);
      sawCompressResult = true;
      if (post < pre) compressDelta = (compressDelta ?? 0) + (pre - post);
    } else if (e.msg.includes('compress') || e.msg.includes('Emergency') || e.msg.includes('Compression')) {
      console.log(`    [status/${e.lvl}] ${e.msg.slice(0, 120)}`);
    }
  }
  if (sawCompressResult && compressDelta && compressDelta > 500) break; // 已见显著回落，收尾
}

const statsPath = path.join(comp.sessionDir, 'stats.json');
let compactCount = 0;
if (fs.existsSync(statsPath)) {
  const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  compactCount = stats.compact_count ?? 0;
  console.log(`\n[3] stats: turn=${stats.turn_count} compact_count=${compactCount} current_context_tokens=${stats.current_context_tokens}`);
}
const summariesDir = path.join(comp.sessionDir, 'summaries');
const hasSummary = fs.existsSync(summariesDir) && fs.readdirSync(summariesDir).some((f) => f.endsWith('.md'));
console.log(`[4] 摘要落盘: ${hasSummary ? '✓' : '✗'}`);

try { await comp.loop.shutdown?.(); } catch { /* ignore */ }

// 判定：压缩触发 + （回落>500 或 compact 后 context 下降）
const ok = sawCompressResult && compressDelta !== null && compactCount > 0;
console.log(`\n=== R3 压缩回落观测: ${ok ? (compressDelta > 500 ? 'PASS（显著回落）' : 'OBSERVED（触发但回落有限）') : 'FAIL'} ===`);
process.exit(ok ? 0 : 1);
