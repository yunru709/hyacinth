import { describe, it, expect, vi } from 'vitest';
import { ResilientProvider } from './resilient.js';
import { FallbackProviderChain } from './fallback.js';
import type { Provider } from './interface.js';
import type { Message, StreamEvent, ProviderType } from '../types.js';

// ── Mock Provider ─────────────────────────────────────────────────

function createMockProvider(opts?: {
  type?: ProviderType;
  model?: string;
  behavior?: 'success' | 'fail-retryable' | 'fail-nonretryable' | 'flaky';
  failCount?: number; // how many times to fail before success (flaky)
}): Provider {
  const type = opts?.type ?? 'anthropic';
  const model = opts?.model ?? 'claude-test';
  let calls = 0;

  return {
    getProviderType: vi.fn(() => type),
    getModel: vi.fn(() => model),
    createStream: vi.fn(async function* () {
      calls++;
      const behavior = opts?.behavior ?? 'success';

      if (behavior === 'flaky') {
        const fc = opts?.failCount ?? 2;
        if (calls <= fc) {
          throw new Error('HTTP 503 Service Unavailable');
        }
        yield { type: 'TEXT' as const, content: 'recovered!' };
        yield { type: 'STOP' as const, reason: 'end_turn' };
        return;
      }

      if (behavior === 'fail-retryable') {
        throw new Error('HTTP 429 Too Many Requests');
      }
      if (behavior === 'fail-nonretryable') {
        throw new Error('HTTP 401 Unauthorized');
      }

      yield { type: 'TEXT' as const, content: 'hello' };
      yield { type: 'STOP' as const, reason: 'end_turn' };
    }),
  };
}

// ── Helpers ───────────────────────────────────────────────────────

async function collectStream(p: Provider, messages: Message[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of p.createStream(messages)) {
    events.push(event);
  }
  return events;
}

const msg: Message = { role: 'user', content: { type: 'text', text: 'hi' } };

// ── ResilientProvider Tests ───────────────────────────────────────

describe('ResilientProvider', () => {
  describe('delegation', () => {
    it('delegates getProviderType to inner', () => {
      const inner = createMockProvider({ type: 'openai' });
      const r = new ResilientProvider(inner);
      expect(r.getProviderType()).toBe('openai');
      expect(inner.getProviderType).toHaveBeenCalled();
    });

    it('delegates getModel to inner', () => {
      const inner = createMockProvider({ model: 'gpt-4o' });
      const r = new ResilientProvider(inner);
      expect(r.getModel()).toBe('gpt-4o');
      expect(inner.getModel).toHaveBeenCalled();
    });

    it('exposes inner provider via getInner()', () => {
      const inner = createMockProvider();
      const r = new ResilientProvider(inner);
      expect(r.getInner()).toBe(inner);
    });
  });

  describe('success path', () => {
    it('passes through stream events', async () => {
      const inner = createMockProvider();
      const r = new ResilientProvider(inner);
      const events = await collectStream(r, [msg]);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'TEXT', content: 'hello' });
      expect(inner.createStream).toHaveBeenCalledTimes(1);
    });

    it('starts with circuit state closed', () => {
      const r = new ResilientProvider(createMockProvider());
      expect(r.getCircuitState()).toBe('closed');
    });
  });

  describe('retry on retryable errors', () => {
    it('retries 503 errors then succeeds', async () => {
      const inner = createMockProvider({ behavior: 'flaky', failCount: 2 });
      const r = new ResilientProvider(inner, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 });
      const events = await collectStream(r, [msg]);
      expect(events).toHaveLength(2);
      expect(inner.createStream).toHaveBeenCalledTimes(3); // 2 fails + 1 success
    });

    it('retries 429 errors then succeeds', async () => {
      const inner = createMockProvider({ behavior: 'flaky', failCount: 1 });
      const r = new ResilientProvider(inner, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 });
      const events = await collectStream(r, [msg]);
      expect(inner.createStream).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting retries', async () => {
      const inner = createMockProvider({ behavior: 'fail-retryable' });
      const r = new ResilientProvider(inner, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 });
      await expect(collectStream(r, [msg])).rejects.toThrow(/429/);
      expect(inner.createStream).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('non-retryable errors', () => {
    it('fails immediately on 401 (no retry)', async () => {
      const inner = createMockProvider({ behavior: 'fail-nonretryable' });
      const r = new ResilientProvider(inner, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 });
      await expect(collectStream(r, [msg])).rejects.toThrow(/401/);
      expect(inner.createStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('circuit breaker', () => {
    it('opens after failureThreshold consecutive failures', async () => {
      const inner = createMockProvider({ behavior: 'fail-retryable' });
      const r = new ResilientProvider(
        inner,
        { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 },
        { failureThreshold: 3, cooldownMs: 60000 },
      );
      for (let i = 0; i < 3; i++) {
        await expect(collectStream(r, [msg])).rejects.toThrow();
      }
      expect(r.getCircuitState()).toBe('open');
    });

    it('resetCircuitBreaker 强制 closed，给予完整重试窗口', async () => {
      const inner = createMockProvider({ behavior: 'fail-nonretryable' });
      const r = new ResilientProvider(
        inner,
        { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 },
        { failureThreshold: 1, cooldownMs: 60000 },
      );
      await expect(collectStream(r, [msg])).rejects.toThrow();
      expect(r.getCircuitState()).toBe('open');
      // 兜底前重置 → closed，不再 fail-fast
      r.resetCircuitBreaker();
      expect(r.getCircuitState()).toBe('closed');
    });

    it('throws circuit breaker message when open', async () => {
      const inner = createMockProvider({ behavior: 'fail-retryable' });
      const r = new ResilientProvider(
        inner,
        { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 },
        { failureThreshold: 1, cooldownMs: 60000 },
      );
      await expect(collectStream(r, [msg])).rejects.toThrow();
      expect(r.getCircuitState()).toBe('open');
      await expect(collectStream(r, [msg])).rejects.toThrow(/Circuit breaker OPEN/);
    });

    it('resets circuit on success', async () => {
      const inner = createMockProvider({ behavior: 'flaky', failCount: 2 });
      const r = new ResilientProvider(
        inner,
        { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 },
        { failureThreshold: 5, cooldownMs: 60000 },
      );
      // 2 failures (below threshold)
      await expect(collectStream(r, [msg])).rejects.toThrow();
      await expect(collectStream(r, [msg])).rejects.toThrow();
      // Then success → resets
      const events = await collectStream(r, [msg]);
      expect(events).toHaveLength(2);
      expect(r.getCircuitState()).toBe('closed');
    });
  });

  describe('default config', () => {
    it('constructs without explicit config', () => {
      const r = new ResilientProvider(createMockProvider());
      expect(r.getCircuitState()).toBe('closed');
    });
  });
});

// ── FallbackProviderChain Tests ───────────────────────────────────

describe('FallbackProviderChain', () => {
  it('succeeds with primary provider', async () => {
    const primary = createMockProvider({ type: 'anthropic', model: 'claude' });
    const fallback = createMockProvider({ type: 'openai', model: 'gpt-4o' });
    const chain = new FallbackProviderChain({ providers: [primary, fallback] });
    const events = await collectStream(chain, [msg]);
    expect(events).toHaveLength(2);
    // primary was called (wrapped in ResilientProvider which delegat)
    expect(primary.createStream).toHaveBeenCalled();
    expect(fallback.createStream).toHaveBeenCalledTimes(0);
  });

  it('falls back on primary failure', async () => {
    const primary = createMockProvider({ behavior: 'fail-nonretryable', type: 'anthropic' });
    const fallback = createMockProvider({ type: 'openai', model: 'gpt-4o' });
    const chain = new FallbackProviderChain({ providers: [primary, fallback] });
    const events = await collectStream(chain, [msg]);
    expect(events).toHaveLength(2);
    expect(primary.createStream).toHaveBeenCalled();
    expect(fallback.createStream).toHaveBeenCalled();
  });

  it('throws aggregated error when all providers fail', async () => {
    const p1 = createMockProvider({ behavior: 'fail-nonretryable', type: 'anthropic' });
    const p2 = createMockProvider({ behavior: 'fail-nonretryable', type: 'openai' });
    const p3 = createMockProvider({ behavior: 'fail-nonretryable', type: 'deepseek' });
    const chain = new FallbackProviderChain({ providers: [p1, p2, p3] });
    await expect(collectStream(chain, [msg])).rejects.toThrow(/All 3 provider\(s\) failed/);
  });

  it('throws on empty providers array', () => {
    expect(() => new FallbackProviderChain({ providers: [] })).toThrow(/at least one provider/);
  });

  it('delegates getProviderType to first provider', () => {
    const primary = createMockProvider({ type: 'groq' });
    const chain = new FallbackProviderChain({ providers: [primary] });
    expect(chain.getProviderType()).toBe('groq');
  });

  it('delegates getModel to first provider', () => {
    const primary = createMockProvider({ model: 'llama-3' });
    const chain = new FallbackProviderChain({ providers: [primary] });
    expect(chain.getModel()).toBe('llama-3');
  });

  it('exposes chain providers via getChainProviders()', () => {
    const p1 = createMockProvider({ type: 'anthropic' });
    const p2 = createMockProvider({ type: 'openai' });
    const chain = new FallbackProviderChain({ providers: [p1, p2] });
    const providers = chain.getChainProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0]).toBeInstanceOf(ResilientProvider);
    expect(providers[0].getInner()).toBe(p1);
    expect(providers[1].getInner()).toBe(p2);
  });

  it('recovers to primary after fallback and fires onRecover', async () => {
    // primary: 第一次调用失败（触发 fallback），第二次成功（触发恢复）
    const primary = createMockProvider({ type: 'anthropic', model: 'claude', behavior: 'flaky', failCount: 1 });
    const fallback = createMockProvider({ type: 'openai', model: 'gpt-4o' });
    const onRecover = vi.fn();
    const chain = new FallbackProviderChain({
      providers: [primary, fallback],
      retry: { maxRetries: 0 }, // 不重试，让 fallback 立即接管
      onRecover,
    });

    // 第一次：primary 失败 → fallback 接管
    await collectStream(chain, [msg]);
    expect(chain.getActiveType()).toBe('openai');
    expect(chain.getActiveModel()).toBe('gpt-4o');
    expect(onRecover).not.toHaveBeenCalled();

    // 第二次：primary 恢复成功 → 切回 primary 并触发 onRecover
    await collectStream(chain, [msg]);
    expect(chain.getActiveType()).toBe('anthropic');
    expect(chain.getActiveModel()).toBe('claude');
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('does not fire onRecover when always on primary', async () => {
    const primary = createMockProvider({ type: 'anthropic', model: 'claude' });
    const fallback = createMockProvider({ type: 'openai', model: 'gpt-4o' });
    const onRecover = vi.fn();
    const chain = new FallbackProviderChain({ providers: [primary, fallback], onRecover });

    await collectStream(chain, [msg]);
    await collectStream(chain, [msg]);
    expect(chain.getActiveType()).toBe('anthropic');
    expect(onRecover).not.toHaveBeenCalled();
  });


  it('fires onRecover when fallback also failed but primary recovers later', async () => {
    // #2 场景：降级已触发（onFallback 已调用），但 fallback 也失败，
    // lastSuccessfulIdx 未移出 0。之后主 provider 恢复成功 → 必须触发 onRecover。
    const onFallback = vi.fn();
    const onRecover = vi.fn();
    // primary: 前 2 次失败，第 3 次成功（模拟挂掉后恢复）
    const primary = createMockProvider({ type: 'anthropic', model: 'claude', behavior: 'flaky', failCount: 2 });
    // fallback: 始终失败（非可重试），导致整条链失败
    const fallback = createMockProvider({ type: 'openai', model: 'gpt-4o', behavior: 'fail-nonretryable' });
    const chain = new FallbackProviderChain({
      providers: [primary, fallback],
      retry: { maxRetries: 0 },
      // 关闭兜底：本用例聚焦「降级触发但 fallback 也失败」的降级/恢复语义
      fallbackToPrimary: false,
      onFallback,
      onRecover,
    });

    // 前两次：primary + fallback 都失败 → 抛聚合错误，lastSuccessfulIdx 保持 0
    await expect(collectStream(chain, [msg])).rejects.toThrow();
    await expect(collectStream(chain, [msg])).rejects.toThrow();
    expect(onFallback).toHaveBeenCalled();
    // lastSuccessfulIdx 未移出 0 → getActiveType 仍是 primary
    expect(chain.getActiveType()).toBe('anthropic');
    expect(onRecover).not.toHaveBeenCalled();

    // 第三次：primary 恢复成功 → 必须触发 onRecover
    await collectStream(chain, [msg]);
    expect(chain.getActiveType()).toBe('anthropic');
    expect(chain.getActiveModel()).toBe('claude');
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

});
