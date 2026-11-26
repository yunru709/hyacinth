/**
 * tool_result 携带图片的契约测试（2026-11-26）
 *
 * 官方协议（2026-11-26 代理直取原文）：
 * - Anthropic：`tool_result.content` 接受 `string | Array<TextBlockParam | ImageBlockParam | ...>`
 * - Gemini 3+：`FunctionResponse.parts` 可带图片
 * - OpenAI Chat Completions：**只接受文本**（tool 消息 content 是 string | TextPart[]）
 *
 * 本文件锁死：
 * 1. 归一化工具函数（toolResultToText / toolResultBlocks / hasToolResultImages）
 * 2. Anthropic 直发数组（text + image 块）
 * 3. OpenAI 系降级为字符串（图片变 `[Image: mime]` 占位，不丢内容）
 */
import { describe, it, expect } from 'vitest';
import { toolResultToText, toolResultBlocks, hasToolResultImages } from '../utils/tool-result.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './compatible.js';
import { OpenAIProvider } from './openai.js';

const IMG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'IMG_B64' } };

const blocks = [{ type: 'text' as const, text: 'screenshot:' }, IMG];

describe('归一化工具函数', () => {
  it('字符串原样返回', () => {
    expect(toolResultToText('hello')).toBe('hello');
    expect(toolResultBlocks('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('数组：文本拼接 + 图片占位', () => {
    expect(toolResultToText(blocks)).toBe('screenshot:[Image: image/png]');
    expect(toolResultBlocks(blocks)).toEqual(blocks);
  });

  it('含图片判定', () => {
    expect(hasToolResultImages(blocks)).toBe(true);
    expect(hasToolResultImages('plain')).toBe(false);
    expect(hasToolResultImages([{ type: 'text', text: 'x' }])).toBe(false);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const VISION_CAPS = {
  toolCalling: true, streaming: true, adapterSupport: false,
  maxContextTokens: 100000, isLocal: false, vision: true, inputTypes: ['text', 'image'],
};
const anthropic = () => {
  const o = Object.create(AnthropicProvider.prototype) as any;
  o.getCapabilities = () => ({ ...VISION_CAPS });
  return o;
};
const compat = () => {
  const o = Object.create(OpenAICompatibleProvider.prototype) as any;
  o.model = 'some-model';
  o.providerType = 'openrouter';
  o.getCapabilities = () => ({ ...VISION_CAPS });
  return o;
};
const openai = () => {
  const o = Object.create(OpenAIProvider.prototype) as any;
  o.model = 'gpt-4o';
  o.getCapabilities = () => ({ ...VISION_CAPS });
  return o;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const userMsgWithToolResult = [
  { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: blocks }] },
];

/**
 * OpenAI 系必须给配对：convertMessages 末尾有 orphan 清洗，
 * 只给 tool_result 而没给 assistant.tool_use 会被当成"无主的 tool"整条丢掉。
 */
const pairedForOpenAI = [
  { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'screenshot', input: {} }] },
  { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: blocks }] },
];

describe('tool_result 带图：Anthropic 直发数组', () => {
  it('产出 text + image 块（不是字符串）', () => {
    const { messages } = anthropic().extractSystemAndMessages(userMsgWithToolResult);
    const tr = messages[0].content[0];
    expect(tr.type).toBe('tool_result');
    expect(Array.isArray(tr.content)).toBe(true);
    const types = tr.content.map((b: { type: string }) => b.type);
    expect(types).toEqual(['text', 'image']);
  });
});

describe('tool_result 带图：OpenAI 系降级为字符串', () => {
  it('compatible → content 是字符串且含图片占位', () => {
    const out = compat().convertMessages(pairedForOpenAI);
    const tool = out.find((m: { role: string }) => m.role === 'tool');
    expect(tool).toBeDefined();
    expect(typeof tool.content).toBe('string');
    expect(tool.content).toContain('screenshot:');
    expect(tool.content).toContain('[Image: image/png]');
  });

  it('openai → 同样降级，不把 image 塞进 tool 消息', () => {
    const out = openai().convertMessages(pairedForOpenAI);
    const tool = out.find((m: { role: string }) => m.role === 'tool');
    expect(tool).toBeDefined();
    expect(typeof tool.content).toBe('string');
    expect(tool.content).toContain('[Image: image/png]');
  });
});
