import { describe, it, expect } from 'vitest';
import { translateFields, PROTOCOL_FIELD_MAP } from './fields.js';
import type { ProviderFields } from './fields.js';
import { DEFAULT_USER_ID } from './user-id.js';

// ─── 协议映射表：覆盖守卫 ──────────────────────────────────────────

describe('PROTOCOL_FIELD_MAP（协议 → wire 字段名）', () => {
  it('四种协议均有 userId 映射', () => {
    for (const kind of ['openai', 'openaiUser', 'anthropic', 'responses'] as const) {
      expect(PROTOCOL_FIELD_MAP[kind].userId).toBeTruthy();
    }
  });

  it('openai：userId → user_id（DeepSeek 语义）', () => {
    expect(PROTOCOL_FIELD_MAP.openai.userId).toBe('user_id');
  });

  it('openaiUser：userId → user（OpenAI 原生标准字段）', () => {
    expect(PROTOCOL_FIELD_MAP.openaiUser.userId).toBe('user');
  });

  it('anthropic：userId → metadata.user_id（嵌套到 metadata）', () => {
    expect(PROTOCOL_FIELD_MAP.anthropic.userId).toBe('metadata.user_id');
  });

  it('responses：userId → user', () => {
    expect(PROTOCOL_FIELD_MAP.responses.userId).toBe('user');
  });
});

// ─── translateFields：协议翻译 ─────────────────────────────────────

describe('translateFields（通用字段 → wire 字段）', () => {
  it('openai：userId + 采样参数全部翻译为顶层字段', () => {
    const fields: ProviderFields = {
      userId: 'pool-a',
      temperature: 0.7,
      topP: 0.9,
      frequencyPenalty: 0.2,
      presencePenalty: 0.1,
      maxOutputTokens: 4096,
    };
    const { topLevel } = translateFields('openai', fields);
    expect(topLevel).toEqual({
      user_id: 'pool-a',
      temperature: 0.7,
      top_p: 0.9,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      max_tokens: 4096,
    });
  });

  it('openaiUser：userId → user（OpenAI 原生端点）', () => {
    const { topLevel } = translateFields('openaiUser', { userId: 'user-x' });
    expect(topLevel).toEqual({ user: 'user-x' });
  });

  it('anthropic：userId → metadata.user_id，采样参数 → 顶层', () => {
    const { topLevel, metadata } = translateFields('anthropic', {
      userId: 'pool-b',
      temperature: 1.0,
      topP: 0.8,
    });
    expect(topLevel).toEqual({ temperature: 1.0, top_p: 0.8 });
    expect(metadata).toEqual({ user_id: 'pool-b' });
  });

  it('anthropic：仅显式设置 userId 才发（保守，不兜底默认值）', () => {
    const { topLevel, metadata } = translateFields('anthropic', { temperature: 0.5 });
    expect(topLevel).toEqual({ temperature: 0.5 });
    expect(metadata).toBeUndefined();
  });

  it('openai/openaiUser：userId 缺省时兜底 DEFAULT_USER_ID（与旧行为一致）', () => {
    const { topLevel } = translateFields('openai', { temperature: 0.5 });
    expect(topLevel.user_id).toBe(DEFAULT_USER_ID);
    const { topLevel: t2 } = translateFields('openaiUser', {});
    expect(t2.user).toBe(DEFAULT_USER_ID);
  });

  it('responses：userId → user，其余采样参数不映射（协议未声明）', () => {
    const { topLevel } = translateFields('responses', {
      userId: 'r-1',
      temperature: 0.5, // responses 协议未映射 → 丢弃
    });
    expect(topLevel).toEqual({ user: 'r-1' });
  });

  it('undefined 字段跳过、null 值跳过', () => {
    const { topLevel, metadata } = translateFields('anthropic', {
      userId: undefined,
      temperature: null as unknown as number | undefined,
      topP: 0.6,
    } as ProviderFields);
    expect(topLevel).toEqual({ top_p: 0.6 });
    expect(metadata).toBeUndefined();
  });

  it('fieldMapOverride：JSON 声明厂商的 per-provider wire 名覆盖', () => {
    // OpenAI 兼容端点用标准 user（覆盖 openai 协议的 user_id）
    const { topLevel } = translateFields('openai', { userId: 'u-1' }, { userId: 'user' });
    expect(topLevel).toEqual({ user: 'u-1' });
  });

  it('fieldMapOverride 部分覆盖：未列出的字段仍走协议默认映射', () => {
    const { topLevel } = translateFields(
      'openai',
      { userId: 'u-1', temperature: 0.7, topP: 0.9 },
      { userId: 'user' }, // 仅覆盖 userId，temperature/topP 走协议默认
    );
    expect(topLevel).toEqual({ user: 'u-1', temperature: 0.7, top_p: 0.9 });
  });

  it('fieldMapOverride 可映射为 metadata. 嵌套（厂商端点差异）', () => {
    const { topLevel, metadata } = translateFields(
      'openai',
      { userId: 'u-1' },
      { userId: 'metadata.client_id' }, // 某厂商要求嵌套到 metadata
    );
    expect(topLevel).toEqual({});
    expect(metadata).toEqual({ client_id: 'u-1' });
  });

  it('空 fields：返回空 topLevel，无 metadata', () => {
    expect(translateFields('openai', undefined)).toEqual({ topLevel: {} });
  });
});
