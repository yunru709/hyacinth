/**
 * smoke-compress.mjs —— R2 场景 2：上下文压缩真实触发验证
 *
 * 报告第四部分 P0 冒烟观察点 2「压缩触发——阈值到达时 compress 阶段
 * 是否真被调用（不只 stub）」。零新功能、纯验证：
 *   - 调小 maxContext（10k）压低 0.75 阈值（7.5k）
 *   - 每轮注入 ~1500 token 长文本，多轮累积逼近阈值
 *   - 观察 onStatus 的 compress-start / compress-result:pre:post /
 *     Emergency 事件 + stats.json compact_count 递增
 *
 * key：优先 DEEPSEEK_API_KEY env，回退 ~/.agent/.env。
 * 用法：node scripts/smoke-compress.mjs
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

// maxContext 压到 8000：0.75 阈值 = 6000，每轮 ~2000 token 长输入第 3-4 轮即逼近
const MAX_CTX = 8_000;
const comp = await createAgent({
  cwd: process.cwd(),
  provider,
  maxTurns: 2,
  maxContext: MAX_CTX,
  outputHandler,
});
console.log('[1] Agent 装配完成, sessionDir:', comp.sessionDir);

// 压缩验证需要小 maxContext：loop 构造以 configCenter 为权威（~/.agent/config.json
// 配了 session.maxContext=200000），createAgent 的 maxContext 参数被忽略。
// 运行时 patch loop 内部三处（内存级，不写盘，只影响本进程）：
const TARGET_CTX = 8_000;
comp.loop.configCenter?.set('session.maxContext', TARGET_CTX);
comp.loop.maxContextTokens = TARGET_CTX;
comp.loop.stageServices?.set('maxContextTokens', TARGET_CTX);
console.log('[1.5] patched maxContextTokens →', TARGET_CTX, '（压缩阈值 =', Math.floor(TARGET_CTX * 0.75) + ')');

// 每轮 ~1400 token 的技术长文（重复段落累积，模拟真实长对话内容）
const PAD = '在分布式系统设计中，一致性协议与分区容错之间存在根本性权衡。Raft 算法通过领导选举、日志复制与安全性的三角设计，在易理解性与正确性之间取得平衡。相较 Paxos 的多阶段协商，Raft 将决策过程收敛到单个领导者，大幅降低了实现复杂度。然而任何复制状态机都无法同时满足强一致、高可用与网络分区容忍，这正是 CAP 定理的约束边界。工程实践中，微服务架构通过事件溯源与读写分离缓解该冲突：写路径采用顺序日志保证可追朔性，读路径借助缓存与物化视图换取低延迟。服务网格则进一步将流量治理下沉到基础设施层，使业务逻辑与容错策略解耦。\n';

function roundInput(i) {
  return `第 ${i} 轮知识性输入，请仅用一句话确认收到即可，不要复述内容：\n${PAD.repeat(10)}`;
}

const N_ROUNDS = 4;
let sawCompressEvent = false;
let pass = true;
for (let i = 1; i <= N_ROUNDS; i++) {
  textChunks.length = 0;
  statusEvents.length = 0;
  const input = roundInput(i);
  console.log(`\n[2] 第 ${i} 轮 (输入 ${Math.round(input.length / 4)} 字符 ≈ ${Math.round(input.length / 2)} token)`);
  const result = await comp.loop.run(input);
  const reply = textChunks.join('').trim();
  console.log(`    回复(${reply.length}字): ${reply.slice(0, 60)}`);

  // 打印本轮 compress 相关事件
  const compEvents = statusEvents.filter((e) =>
    e.msg.includes('compress') || e.msg.includes('Emergency') || e.msg.includes('Compression'));
  for (const e of compEvents) {
    console.log(`    [status/${e.lvl}] ${e.msg.slice(0, 140)}`);
  }
  // 压缩事件已出现 → 触发验证达成，提前收尾（避免后续反复压缩拖长运行）
  if (statusEvents.some((e) => e.msg.startsWith('compress-result:'))) {
    sawCompressEvent = true;
    console.log('    压缩已真实触发，提前结束轮次');
    break;
  }
  void result;
}

// 验收：stats compact_count > 0
const statsPath = path.join(comp.sessionDir, 'stats.json');
let compactCount = 0;
let turnCount = 0;
if (fs.existsSync(statsPath)) {
  const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  compactCount = stats.compact_count ?? 0;
  turnCount = stats.turn_count ?? 0;
  console.log(`\n[3] stats.json: turn_count=${turnCount} compact_count=${compactCount}`);
}

try { await comp.loop.shutdown?.(); } catch { /* ignore */ }

// 从事件流再确认一次（事件可能跨轮输出）
let sawCompress = false;
console.log('\n[4] 全程压缩事件扫描:');
for (let i = 1; i <= N_ROUNDS; i++) {
  // 事件是逐轮收集的，这里补查 logs（通过 sessions 目录 events.jsonl 更可靠）
}
const eventsPath = path.join(comp.sessionDir, 'events.jsonl');
if (fs.existsSync(eventsPath)) {
  const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean);
  for (const l of lines) {
    if (l.includes('compact') || l.includes('compress')) {
      sawCompress = true;
      console.log('  ', l.slice(0, 160));
    }
  }
}

// 验收证据 3：摘要落盘（压缩把历史总结保存到 summaries/ —— 压缩真实生效的可观测证明）
const summariesDir = path.join(comp.sessionDir, 'summaries');
let summaryFiles = 0;
if (fs.existsSync(summariesDir)) {
  summaryFiles = fs.readdirSync(summariesDir).filter((f) => f.endsWith('.md')).length;
  console.log(`\n[5] 摘要落盘: summaries/ 含 ${summaryFiles} 个 .md（压缩摘要真实保存）`);
}

const ok = sawCompressEvent && (compactCount > 0 || summaryFiles > 0);
console.log(`\n=== R2-2 压缩触发验证: ${ok ? 'PASS' : 'FAIL'} (compress-result=${sawCompressEvent}, compact_count=${compactCount}, summaries=${summaryFiles}) ===`);
process.exit(ok ? 0 : 1);
