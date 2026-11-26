/**
 * 角色能力清单的矩阵测试（2026-11-21）
 *
 * 目的：把「哪个厂商 + 哪个模型能吃什么角色」变成可执行断言。
 * 新增厂商 / 新角色形态时，先改 role-capabilities.ts，再让这里红一次 —— 防止
 * 2026-11-08 那类"漏写分支、静默降级"的事故重演。
 */
import { describe, it, expect } from 'vitest';
import { resolveRoleCapabilities, DEVELOPER_ROLE_MODELS_RE } from './role-capabilities.js';

describe('role-capabilities：developer 角色判定', () => {
  it('官方 OpenAI 的新模型 → developer', () => {
    for (const model of ['gpt-5', 'gpt-5.5', 'o1', 'o1-mini', 'o3', 'o3-mini', 'codex-mini-latest']) {
      expect(resolveRoleCapabilities('openai', model).supportsDeveloperRole, model).toBe(true);
    }
  });

  it('官方 OpenAI 的旧模型 → 仍用 system', () => {
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'chatgpt-4o-latest']) {
      expect(resolveRoleCapabilities('openai', model).supportsDeveloperRole, model).toBe(false);
    }
  });

  it('中转/兼容厂商即使模型名命中也不切 developer（保守：中转层认不认无法保证）', () => {
    for (const p of ['deepseek', 'xai', 'groq', 'mistral', 'openrouter', 'opencode', 'ollama', 'llamacpp'] as const) {
      expect(resolveRoleCapabilities(p, 'gpt-5.5').supportsDeveloperRole, p).toBe(false);
      expect(resolveRoleCapabilities(p, 'o1').supportsDeveloperRole, p).toBe(false);
    }
  });

  it('模型名缺失/为空 → 保持 system，不抛错', () => {
    expect(resolveRoleCapabilities('openai', undefined).supportsDeveloperRole).toBe(false);
    expect(resolveRoleCapabilities('openai', '').supportsDeveloperRole).toBe(false);
  });

  it('匹配是前缀锚定：gpt-50 / xgpt-5 之类不会被误判', () => {
    expect(DEVELOPER_ROLE_MODELS_RE.test('gpt-50')).toBe(true); // 前缀就是 gpt-5（真实模型不会叫这个）
    expect(DEVELOPER_ROLE_MODELS_RE.test('xgpt-5')).toBe(false);
    expect(DEVELOPER_ROLE_MODELS_RE.test('my-o1-proxy')).toBe(false);
  });
});

describe('role-capabilities：system 落点与 tool 角色', () => {
  it('Anthropic：system 走顶层参数，tool 结果用 user 承载', () => {
    const caps = resolveRoleCapabilities('anthropic', 'claude-sonnet-5');
    expect(caps.systemPlacement).toBe('top-level');
    expect(caps.toolRole).toBe('user');
    expect(caps.supportsDeveloperRole).toBe(false);
  });

  it('Gemini：system 走 systemInstruction', () => {
    const caps = resolveRoleCapabilities('gemini', 'gemini-3-pro');
    expect(caps.systemPlacement).toBe('systemInstruction');
    expect(caps.toolRole).toBe('user');
  });

  it('OpenAI 系：system 在 messages 里，tool 用独立 tool 角色', () => {
    for (const p of ['openai', 'deepseek', 'openrouter', 'local'] as const) {
      const caps = resolveRoleCapabilities(p, 'gpt-4o');
      expect(caps.systemPlacement, p).toBe('messages');
      expect(caps.toolRole, p).toBe('tool');
    }
  });
});
