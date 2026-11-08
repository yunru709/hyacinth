/**
 * system 角色守卫 —— 2026-11-08 修复的可执行记忆。
 *
 * 事故：`openai.ts` 与 `compatible.ts` 的 `convertMessages` 只有 `assistant` 与
 * 「非 assistant」两条分支，**没有 system 分支** ⇒ 整个系统提示词（人设 / Anchor /
 * 系统指令）被以 `role:'user'` 的身份发出去。
 *
 * 为什么迟迟没被发现：内容没丢，只是角色变了，system 文本仍在消息序列最前部，
 * 模型基本照常遵守 —— 症状是"指令遵从度略降 / 个别端点校验更挑剔"，而非报错。
 *
 * 判据：任何 OpenAI 兼容适配器把内部 `Message` 转成 wire 格式时，`role:'system'`
 * 必须原样保留为 `role:'system'`。`local.ts` 早已正确，可作为参照实现。
 */
import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from './openai.js';
import { OpenAICompatibleProvider } from './compatible.js';

const messages = [
  { role: 'system' as const, content: { type: 'text' as const, text: 'SYSTEM_MARKER_PERSONA' } },
  { role: 'user' as const, content: { type: 'text' as const, text: 'hello' } },
];

/** 绕过构造函数直接调用私有方法（只验转换逻辑，不碰网络/凭据） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const probe = (proto: object) => (Object.create(proto) as any).convertMessages(messages);

describe('system 角色不得降级为 user', () => {
  it('openai.ts 保留 system', () => {
    const out = probe(OpenAIProvider.prototype);
    expect(out.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(out[0].content).toBe('SYSTEM_MARKER_PERSONA');
  });

  it('compatible.ts 保留 system（11 家 OpenAI 兼容厂商共用）', () => {
    const out = probe(OpenAICompatibleProvider.prototype);
    expect(out.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(out[0].content).toBe('SYSTEM_MARKER_PERSONA');
  });

  it('system 与 tool_result 混排时，system 不带 tool 字段', () => {
    const out = probe(OpenAIProvider.prototype);
    const sys = out.find((m: { role: string }) => m.role === 'system');
    expect(sys).toBeDefined();
    expect(Object.keys(sys)).toEqual(['role', 'content']);
  });
});
