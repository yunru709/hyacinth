/**
 * 工具调用策略映射测试（2026-11-26）
 *
 * 覆盖三家官方文档确认的映射：
 * - OpenAI：auto / none / required / {type:'function',function:{name}}
 * - Anthropic：auto / none / any(required) / tool(name)，+ disable_parallel_tool_use
 * - Gemini：AUTO / NONE / ANY / ANY+allowedFunctionNames
 *
 * 注意：这里只测纯映射函数（不碰网络），adapter 的接线由 tsc + 全量测试兜底。
 */
import { describe, it, expect } from 'vitest';
import {
  toOpenAIToolChoice,
  toAnthropicToolChoice,
  toGeminiToolConfig,
  type ToolChoice,
} from './tool-policy.js';

describe('toOpenAIToolChoice', () => {
  it('字符串三态直接透传', () => {
    for (const c of ['auto', 'none', 'required'] as const) {
      expect(toOpenAIToolChoice(c)).toBe(c);
    }
  });

  it('指定工具 → function 形态', () => {
    expect(toOpenAIToolChoice({ name: 'get_weather' })).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });
});

describe('toAnthropicToolChoice', () => {
  it('required 映射为 any（Anthropic 的"至少一个"）', () => {
    expect(toAnthropicToolChoice('required')).toEqual({ type: 'any' });
  });

  it('指定工具 → tool + name', () => {
    expect(toAnthropicToolChoice({ name: 'read_file' })).toEqual({
      type: 'tool',
      name: 'read_file',
    });
  });

  it('parallelToolCalls=false 时挂 disable_parallel_tool_use', () => {
    expect(toAnthropicToolChoice('auto', false)).toEqual({
      type: 'auto',
      disable_parallel_tool_use: true,
    });
    expect(toAnthropicToolChoice('required', false)).toEqual({
      type: 'any',
      disable_parallel_tool_use: true,
    });
    expect(toAnthropicToolChoice({ name: 'x' }, false)).toEqual({
      type: 'tool',
      name: 'x',
      disable_parallel_tool_use: true,
    });
  });

  it('none 不理会 parallelToolCalls（本身不调用工具）', () => {
    expect(toAnthropicToolChoice('none', false)).toEqual({ type: 'none' });
  });

  it('parallelToolCalls=true / 未设置 ⇒ 不带该字段', () => {
    expect(toAnthropicToolChoice('auto', true)).toEqual({ type: 'auto' });
    expect(toAnthropicToolChoice('auto')).toEqual({ type: 'auto' });
  });
});

describe('toGeminiToolConfig', () => {
  it('三态映射', () => {
    const cases: Array<[ToolChoice, string]> = [
      ['auto', 'AUTO'],
      ['none', 'NONE'],
      ['required', 'ANY'],
    ];
    for (const [input, mode] of cases) {
      expect(toGeminiToolConfig(input).functionCallingConfig.mode).toBe(mode);
    }
  });

  it('指定工具 → ANY + allowedFunctionNames', () => {
    expect(toGeminiToolConfig({ name: 'search' })).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] },
    });
  });
});
