/**
 * smoke-assembly.mjs —— 真实装配链冒烟（报告第 1 项「启动即活」补课）。
 *
 * 走 createAgent 完整装配链（kernel 三件套 / 16 装配批 / 插件挂载 / AgentLoop），
 * 验证「启动即活」：装配不崩 + pipeline 6 槽就绪 + pluginHost 可用。
 * 注入 stub provider（不提供 createStream）——冒烟只验证装配，不调用 LLM。
 *
 * 用法：node scripts/smoke-assembly.mjs
 * 退出码：0=通过；非 0=失败
 */

import { createAgent } from '../dist/gateway/factory.js';

// stub provider：满足装配期读到的 getProviderType/getModel/getCapabilities，
// 不提供 createStream（冒烟不触发 LLM 调用）
const provider = {
  getProviderType: () => 'deepseek',
  getModel: () => 'deepseek-chat',
  getCapabilities: () => ({ vision: false }),
  setThinking: () => {},
};

const outputHandler = {};

try {
  const comp = await createAgent({
    cwd: process.cwd(),
    provider,
    maxTurns: 1,
    maxContext: 8000,
    outputHandler,
  });

  // 1. AgentLoop 装配完成
  if (typeof comp.loop?.run !== 'function') throw new Error('loop.run 缺失');
  console.log('[1] AgentLoop 装配完成: loop.run=%s', typeof comp.loop.run);

  // 2. kernel.pipeline 6 槽就绪
  const slots = comp.loop.pipeline.describe().map((s) => s.slot);
  console.log('[2] pipeline 槽位: %s', slots.join(' -> '));
  const expected = ['input', 'bypass', 'context', 'llm', 'tools', 'finalize'];
  if (slots.join(',') !== expected.join(',')) {
    throw new Error(`槽位不符: ${slots.join(',')}（期望 ${expected.join(',')}）`);
  }

  // 3. runSlot API 可用（P0 修复产物在 dist）
  if (typeof comp.loop.pipeline.runSlot !== 'function') {
    throw new Error('pipeline.runSlot 缺失（dist 未包含 P0 修复？）');
  }
  console.log('[3] pipeline.runSlot 可用（P0 修复已在产物）');

  // 4. pluginHost 可用
  console.log('[4] pluginHost: %s', typeof comp.loop.pluginHost?.get);
  if (!comp.loop.pluginHost) throw new Error('pluginHost 缺失');

  // 5. 阶段服务表就绪（context 阶段 require 的服务键）
  const svc = comp.loop['stageServices'] ?? new Map();
  const required = ['conversationStore', 'toolRegistry', 'contextComposer', 'compressor', 'statsManager', 'gitManager', 'maxContextTokens', 'loopHooks', 'getRouter', 'eventStore', 'orchestrator', 'sessionDir'];
  const missing = required.filter((k) => svc.get ? svc.get(k) === undefined : !(k in svc));
  if (missing.length > 0) throw new Error(`阶段服务缺失: ${missing.join(', ')}`);
  console.log('[5] 阶段服务表完整（%d 键）', required.length);

  console.log('\n✅ 装配冒烟通过：启动即活（装配链端到端无异常）');
  process.exit(0);
} catch (err) {
  console.error('\n❌ 装配冒烟失败:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
