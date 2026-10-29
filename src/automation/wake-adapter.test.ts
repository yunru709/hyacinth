/**
 * Where → 会话唤醒适配器测试（2026-10-30）
 *
 * 锁死的核心：
 *   1. reuse 走 runPrompt（续上下文）、new 走 runPromptInNewSession（干净上下文）
 *   2. target.sessionId 在两种策略下语义不同（在这里跑 vs 结果投回这里）
 *   3. 端口缺失 / 未实现方法 ⇒ **抛错**，绝不静默
 */

import { describe, expect, it, vi } from 'vitest';

import type { RuleEvent } from './runner.js';
import { createWakeSession } from './wake-adapter.js';
import type { Where } from './types.js';

const event: RuleEvent = { source: 'watch', name: 'n', at: Date.now(), payload: {} };

describe('createWakeSession：reuse', () => {
  it('调 runPrompt(channel, sessionId, prompt)', async () => {
    const runPrompt = vi.fn(async () => {});
    const fn = createWakeSession(() => ({ runPrompt }));

    await fn({ policy: 'reuse', target: { channel: 'feishu', sessionId: 's1' } }, '干活', event);

    expect(runPrompt).toHaveBeenCalledWith('feishu', 's1', '干活');
  });

  it('缺 sessionId → 抛错（校验层已拦，这里兜底手工配置）', async () => {
    const fn = createWakeSession(() => ({ runPrompt: async () => {} }));
    await expect(fn({ policy: 'reuse', target: { channel: 'webui' } }, 'x', event)).rejects.toThrow(
      'target.sessionId',
    );
  });

  it('端口未实现 runPrompt → 抛错（不静默）', async () => {
    const fn = createWakeSession(() => ({}));
    await expect(
      fn({ policy: 'reuse', target: { sessionId: 's1' } }, 'x', event),
    ).rejects.toThrow('未实现 runPrompt');
  });
});

describe('createWakeSession：new', () => {
  it('调 runPromptInNewSession，sessionId 变义为 deliverSessionId', async () => {
    const runPromptInNewSession = vi.fn(async () => {});
    const fn = createWakeSession(() => ({ runPromptInNewSession }));

    await fn(
      { policy: 'new', target: { channel: 'feishu', sessionId: 'deliver-1' }, ttlMs: 60_000 },
      '分析日志',
      event,
    );

    expect(runPromptInNewSession).toHaveBeenCalledWith({
      channel: 'feishu',
      prompt: '分析日志',
      deliverSessionId: 'deliver-1',
      ttlMs: 60_000,
    });
  });

  it('无 target 时用默认渠道，且不带 deliverSessionId', async () => {
    const runPromptInNewSession = vi.fn(async () => {});
    const fn = createWakeSession(() => ({ runPromptInNewSession }));

    await fn({ policy: 'new' }, 'x', event);

    expect(runPromptInNewSession).toHaveBeenCalledWith({ channel: 'webui', prompt: 'x' });
  });

  it('端口未实现 runPromptInNewSession → 抛错（不静默）', async () => {
    const fn = createWakeSession(() => ({ runPrompt: async () => {} }));
    await expect(fn({ policy: 'new' }, 'x', event)).rejects.toThrow('未实现 runPromptInNewSession');
  });
});

describe('createWakeSession：渠道优先级与端口', () => {
  it('target.channel > fallback[0] > 默认 webui', async () => {
    const runPrompt = vi.fn(async () => {});
    const fn = createWakeSession(() => ({ runPrompt }));
    const base: Where = { policy: 'reuse', target: { sessionId: 's1' } };

    await fn({ ...base, target: { ...base.target, channel: 'tui' } }, 'p', event);
    await fn({ ...base, fallback: ['feishu', 'tui'] }, 'p', event);
    await fn(base, 'p', event);

    expect(runPrompt.mock.calls.map((c) => c[0])).toEqual(['tui', 'feishu', 'webui']);
  });

  it('端口未注入 → 抛错并指明检查点', async () => {
    const fn = createWakeSession(() => undefined);
    await expect(fn({ policy: 'new' }, 'x', event)).rejects.toThrow('会话端口未注入');
  });
});
