/**
 * smoke-m2.mjs —— M2 核心对话体验真实验证（多轮连续记忆 + 工具真实调用）
 *
 * 在同一个 AgentLoop 实例上连续调 loop.run() 多轮，验证：
 *   1. 多轮连续记忆：第二轮能否记得第一轮告知的信息（context 阶段注入会话历史）
 *   2. 工具真实调用：让 agent 用 read_file 读取文件，验证 tools 阶段真实执行
 *   3. 会话落盘：多轮 conversation.jsonl 条目完整
 *
 * key 读取：优先 DEEPSEEK_API_KEY 环境变量，回退 ~/.agent/.env（项目凭证体系）。
 * 用法：node scripts/smoke-m2.mjs
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

const ROUNDS = [
  { label: 'R1 记忆写入', input: '我的名字叫孑遗，请记住这个名字，不要忘记。', expect: null },
  { label: 'R2 记忆回读', input: '我叫什么名字？', expect: '孑遗' },
  { label: 'R3 工具调用', input: '请用 read_file 工具读取 package.json 的前 8 行内容。', expect: null, tool: true },
];

const texts = [];
let toolUsed = false;
let toolResults = 0;
const outputHandler = {
  onText: (c) => { texts.push(c); },
  onThinking: () => {},
  onTurnStart: () => {},
  onToolUse: (name) => { toolUsed = true; console.log('    [tool-use]', name); },
  onToolResult: (name, ok) => { toolResults++; console.log('    [tool-result]', name, ok ? 'ok' : 'err'); },
  onDiff: () => {},
  onStatus: () => {},
  onFlush: () => {},
  onInterrupt: () => {},
  onAskUser: () => Promise.resolve('{}'),
};

const comp = await createAgent({
  cwd: process.cwd(),
  provider,
  maxTurns: 5,
  maxContext: 20000,
  outputHandler,
});
console.log('[1] Agent 装配完成, sessionDir:', comp.sessionDir);

let pass = true;
for (const round of ROUNDS) {
  texts.length = 0;
  toolUsed = false;
  console.log(`\n[2] ${round.label}: ${round.input}`);
  const result = await comp.loop.run(round.input);
  const reply = texts.join('').trim();
  console.log(`    stop: ${JSON.stringify(result?.stop ?? result)}`);
  console.log(`    回复(${reply.length}字): ${reply.slice(0, 120)}`);

  if (!reply) { console.log('    ✗ 空回复'); pass = false; continue; }
  if (round.expect && !reply.includes(round.expect)) {
    console.log(`    ✗ 未提到预期内容「${round.expect}」`);
    pass = false;
  } else if (round.expect) {
    console.log(`    ✓ 记得「${round.expect}」（多轮记忆生效）`);
  }
  if (round.tool) {
    console.log(`    工具调用: ${toolUsed ? '✓ 触发' : '✗ 未触发'} | 结果: ${toolResults}`);
    if (!toolUsed) pass = false;
  }
}

// 会话落盘验证
const convPath = path.join(comp.sessionDir, 'conversation.jsonl');
if (fs.existsSync(convPath)) {
  const lines = fs.readFileSync(convPath, 'utf-8').trim().split('\n').filter(Boolean);
  const userCount = lines.filter((l) => JSON.parse(l).role === 'user').length;
  console.log(`\n[3] conversation.jsonl 落盘: ${lines.length} 条 (user ${userCount} / assistant ${lines.length - userCount})`);
  if (userCount < ROUNDS.length) { console.log('    ✗ user 条目不足'); pass = false; }
  else console.log(`    ✓ ${userCount} 轮 user 输入全部落盘（多轮连续记忆落盘）`);
} else {
  console.log('\n[3] ✗ conversation.jsonl 未找到');
  pass = false;
}

try { await comp.loop.shutdown?.(); } catch { /* ignore */ }
console.log(`\n=== M2 结果: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
