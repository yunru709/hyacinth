/**
 * 图片在不同角色下的契约测试（2026-11-26）
 *
 * 背景：内部 `MessageContent` 允许 image 出现在任意 role 的 content 里，但各家协议
 * 对"图片能挂在谁身上"有硬性规定：
 *   - OpenAI 系：image_url 只能在 **user** 的 content parts 里；
 *   - Anthropic：image block 只能在 **user** 消息里（assistant 侧会被 400）。
 * 所以 assistant 消息带图时，适配器必须**显式降级为文本占位**，不能静默丢
 * （2026-11-08 的教训：漏了不报错，比报错更糟）。
 *
 * 本文件锁死三条路：assistant+image 不丢、user+image 保留、非视觉模型降级。
 */
import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider } from './compatible.js';
import { LocalProvider } from './local.js';
import { AnthropicProvider } from './anthropic.js';

const IMG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'IMG_B64' } };

const assistantWithImage = [
  { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'here' }, IMG] },
  { role: 'user' as const, content: { type: 'text' as const, text: 'go' } },
];

const userWithImage = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, IMG] },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
/** 模拟实例必须显式给 vision=true：真实实例的 getCapabilities 依赖模型目录，
 *  用假模型名会落到 vision=false，导致"合法路径"被测成降级 —— 这是脚手架问题，不是代码问题。 */
const VISION_CAPS = {
  toolCalling: true, streaming: true, adapterSupport: false,
  maxContextTokens: 100000, isLocal: false, vision: true, inputTypes: ['text', 'image'],
};
const compat = () => {
  const o = Object.create(OpenAICompatibleProvider.prototype) as any;
  o.model = 'some-model';
  o.providerType = 'openrouter';
  o.getCapabilities = () => ({ ...VISION_CAPS });
  return o;
};
const local = () => {
  const o = Object.create(LocalProvider.prototype) as any;
  o.model = 'llama-3.1';
  o._providerType = 'local';
  o.getCapabilities = () => ({ ...VISION_CAPS });
  return o;
};
const anthropic = (vision = true) => {
  const o = Object.create(AnthropicProvider.prototype) as any;
  o.getCapabilities = () => ({
    toolCalling: true, streaming: true, adapterSupport: false,
    maxContextTokens: 100000, isLocal: false, vision,
    inputTypes: vision ? ['text', 'image'] : ['text'],
  });
  return o;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('assistant 消息带图片：必须降级为文本，不得静默丢弃', () => {
  it('compatible（OpenAI 系）→ 文本占位', () => {
    const out = compat().convertMessages(assistantWithImage);
    const asst = out.find((m: { role: string }) => m.role === 'assistant');
    expect(asst).toBeDefined();
    expect(typeof asst.content).toBe('string');
    expect(asst.content).toContain('[Image: image/png]');
    // 不能把 image 塞进 assistant 的 content parts（协议不允许）
    expect(JSON.stringify(asst)).not.toContain('image_url');
  });

  it('local（llama.cpp/Ollama）→ 文本占位', () => {
    const out = local().convertMessages(assistantWithImage);
    const asst = out.find((m: { role: string }) => m.role === 'assistant');
    expect(asst).toBeDefined();
    expect(typeof asst.content).toBe('string');
    expect(asst.content).toContain('[Image: image/png]');
  });

  it('anthropic → 文本块（不是 image 块）', () => {
    const { messages } = anthropic().extractSystemAndMessages(assistantWithImage);
    const asst = messages.find((m: { role: string }) => m.role === 'assistant');
    expect(asst).toBeDefined();
    const types = asst.content.map((b: { type: string }) => b.type);
    expect(types).not.toContain('image');
    expect(types).toContain('text');
    expect(JSON.stringify(asst.content)).toContain('[Image: image/png]');
  });
});

describe('user 消息带图片：必须原样保留（这是合法路径）', () => {
  it('compatible → image_url part', () => {
    const out = compat().convertMessages(userWithImage);
    expect(JSON.stringify(out)).toContain('image_url');
  });

  it('anthropic → image block', () => {
    const { messages } = anthropic().extractSystemAndMessages(userWithImage);
    const types = messages[0].content.map((b: { type: string }) => b.type);
    expect(types).toContain('image');
  });

  it('anthropic + 非视觉模型 → 文本占位（不丢）', () => {
    const { messages } = anthropic(false).extractSystemAndMessages(userWithImage);
    const types = messages[0].content.map((b: { type: string }) => b.type);
    expect(types).not.toContain('image');
    expect(JSON.stringify(messages[0].content)).toContain('[Image: image/png]');
  });
});
