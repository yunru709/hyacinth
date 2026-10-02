/**
 * thinking-style 单测 —— 思考开关的 wire 语义（厂商差异收敛点）。
 *
 * 背景（全部实测确认，见 thinking-style.ts 文件头）：
 *   ① 非 deepseek 厂商曾一个字段都发不出去；
 *   ② 字段曾包在 `extra_body` 里 —— Python SDK 写法，Node SDK 不展开 ⇒ 官方读不到；
 *   ③ "关闭"曾只有 `thinking:{type:'disabled'}` 一种写法，只认 effort 枚举的上游
 *      （commandcode：off|low|medium|high|xhigh|max）根本不认，导致关不掉。
 */
import { describe, it, expect } from 'vitest';
import {
  buildThinkingParams,
  buildAnthropicThinking,
  normalizeThinkingStyle,
  EFFORT_OFF,
} from './thinking-style.js';

describe('normalizeThinkingStyle', () => {
  it('接受四个合法值，并容错大小写与空白', () => {
    expect(normalizeThinkingStyle('deepseek')).toBe('deepseek');
    expect(normalizeThinkingStyle('effort')).toBe('effort');
    expect(normalizeThinkingStyle('anthropic')).toBe('anthropic');
    expect(normalizeThinkingStyle('none')).toBe('none');
    expect(normalizeThinkingStyle('  EFFORT ')).toBe('effort');
  });

  it('非法值一律回落 undefined（不抛错、不把错拼的字符串透传到 wire）', () => {
    expect(normalizeThinkingStyle('deepseekThinking')).toBeUndefined();
    expect(normalizeThinkingStyle('true')).toBeUndefined();
    expect(normalizeThinkingStyle('')).toBeUndefined();
    expect(normalizeThinkingStyle(undefined)).toBeUndefined();
    expect(normalizeThinkingStyle(null)).toBeUndefined();
    expect(normalizeThinkingStyle(123)).toBeUndefined();
    expect(normalizeThinkingStyle({})).toBeUndefined();
  });
});

describe('buildThinkingParams（OpenAI 兼容层）', () => {
  it('deepseek 开启：顶层 thinking.enabled + 顶层 reasoning_effort', () => {
    const p = buildThinkingParams('deepseek', true, 'high');
    expect(p).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });

  it('deepseek 关闭：顶层 thinking.disabled（官方默认 enabled，不发就关不掉）', () => {
    const p = buildThinkingParams('deepseek', false);
    expect(p).toEqual({ thinking: { type: 'disabled' } });
    // 关闭时不应残留 reasoning_effort
    expect(p).not.toHaveProperty('reasoning_effort');
  });

  it('effort 关闭：必须发 reasoning_effort=off（上游默认开着，只有显式 off 能关）', () => {
    expect(buildThinkingParams('effort', false)).toEqual({ reasoning_effort: EFFORT_OFF });
  });

  it('effort 开启：发档位，缺省 high', () => {
    expect(buildThinkingParams('effort', true, 'max')).toEqual({ reasoning_effort: 'max' });
    expect(buildThinkingParams('effort', true)).toEqual({ reasoning_effort: 'high' });
  });

  it('none / anthropic：不产生任何字段（缺省保守，不塞未知字段给网关）', () => {
    expect(buildThinkingParams('none', true, 'high')).toEqual({});
    expect(buildThinkingParams('none', false)).toEqual({});
    expect(buildThinkingParams('anthropic', true, 'high')).toEqual({});
  });

  it('任何 style 都不得产出 extra_body —— 那是 Python SDK 参数名，Node SDK 不展开', () => {
    for (const style of ['deepseek', 'effort', 'anthropic', 'none'] as const) {
      for (const enabled of [true, false]) {
        const p = buildThinkingParams(style, enabled, 'high');
        expect(p).not.toHaveProperty('extra_body');
        // 顶层才是官方认的位置（DeepSeek 文档示例即顶层 thinking / reasoning_effort）
        expect(Object.keys(p).every((k) => k === 'thinking' || k === 'reasoning_effort')).toBe(true);
      }
    }
  });
});

describe('buildAnthropicThinking（Anthropic 协议层）', () => {
  it('anthropic 开启：延长思考块', () => {
    expect(buildAnthropicThinking('anthropic', true, 10000)).toEqual({
      type: 'enabled',
      budget_tokens: 10000,
    });
  });

  it('anthropic 关闭：不发（Anthropic 默认不思考，无需显式关）', () => {
    expect(buildAnthropicThinking('anthropic', false, 10000)).toBeUndefined();
  });

  it('声明为 none 的 anthropic 兼容端点：即使开启也不发（语法未验证，宁可不发）', () => {
    expect(buildAnthropicThinking('none', true, 10000)).toBeUndefined();
  });
});
