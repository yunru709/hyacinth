/**
 * smoke-real.mjs —— 真实整机冒烟（M1，替代 CLI 完整装配）。
 *
 * 绕过 CLI 的复杂装配（MCP/渠道/后端），直接 createAgent + 真实 provider
 * + loop.processUserInput 跑一轮真实对话。验证：provider 路由、会话落盘、
 * 真实 LLM 回复。key 从 DEEPSEEK_API_KEY 环境变量临时读取（不持久化）。
 *
 * 用法：DEEPSEEK_API_KEY=xxx node scripts/smoke-real.mjs
 */

import { createAgent } from '../dist/gateway/factory.js';
import { ProviderManager } from '../dist/provider/manager.js';
import { getProviderConfigLoader } from '../dist/provider/config.js';

const key = process.env.DEEPSEEK_API_KEY;
if (!key) { console.error('缺少 DEEPSEEK_API_KEY'); process.exit(1); }

// 先初始化 ProviderConfigLoader（deepseek 工厂运行时读默认 meta）
getProviderConfigLoader(process.cwd());

// 真实 provider（deepseek，key 走临时 env）
const manager = new ProviderManager({ type: 'deepseek', apiKey: key, model: 'deepseek-v4-flash' });
const provider = manager.getProvider();
console.log('[0] provider 就绪:', provider.getProviderType(), '/', provider.getModel());

// 收集流式输出
const texts = [];
const outputHandler = {
  onText: (c) => { texts.push(c); },
  onThinking: () => {},
  onTurnStart: () => {},
  onToolUse: () => {},
  onToolResult: () => {},
  onDiff: () => {},
  onStatus: () => {},
  onFlush: () => {},
  onInterrupt: () => {},
  onAskUser: () => Promise.resolve('{}'),
};

const comp = await createAgent({
  cwd: process.cwd(),
  provider,
  maxTurns: 1,
  maxContext: 20000,
  outputHandler,
});
console.log('[1] Agent 装配完成, sessionDir:', comp.sessionDir);

const input = '请用一句话介绍你自己';
const result = await comp.loop.run(input);
const reply = texts.join('');
console.log('[2] 对话完成, stop:', result?.stop ?? result);
console.log('[3] 模型回复:', reply || '(空)');
console.log('[4] 会话目录:', comp.sessionDir);

// 验证会话落盘
const fs = await import('node:fs');
const path = await import('node:path');
const convPath = path.join(comp.sessionDir, 'conversation.jsonl');
if (fs.existsSync(convPath)) {
  const lines = fs.readFileSync(convPath, 'utf-8').trim().split('\n');
  console.log('[5] conversation.jsonl 落盘:', lines.length, '条');
  console.log('[6] 输入一致性:', JSON.stringify(lines[0]).includes(input.slice(0, 10)) ? '✓ 输入已落盘' : '✗ 输入未落盘');
} else {
  console.log('[5] ✗ conversation.jsonl 未找到（会话未落盘？）');
}

// 善后
try { await comp.loop.shutdown?.(); } catch { /* ignore */ }
process.exit(reply ? 0 : 1);
