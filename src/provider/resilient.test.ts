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

  describe('idle timeout（流挂起不无限等待）', () => {
    it('底层流无事件超时 → 抛可重试错误（不依赖底层响应 abort）', async () => {
      // 挂起流：yield 一个事件后永久挂起（模拟网络半开：连接建立但不再推数据）
      const hangProvider: Provider = {
        getProviderType: () => 'anthropic',
        getModel: () => 'claude-hang',
        createStream: vi.fn(async function* () {
          yield { type: 'TEXT' as const, content: 'start' };
          await new Promise(() => {}); // 永不 resolve
        }),
      };
      // idleTimeoutMs=50ms：很快触发空闲超时
      const r = new ResilientProvider(hangProvider, undefined, {
        failureThreshold: 100,
        cooldownMs: 0,
        idleTimeoutMs: 50,
      });
      const events: StreamEvent[] = [];
      // 已 yield 过 → 空闲超时后 hasYielded=true → 直接抛错（不重试）
      await expect(async () => {
        for await (const ev of r.createStream([msg])) {
          events.push(ev);
        }
      }).rejects.toThrow(/idle timeout/);
      expect(events.length).toBeGreaterThanOrEqual(1); // 收到过 start
    });

    it('idleTimeoutMs=0 禁用 → 正常流走完不抛空闲超时错误', async () => {
      const okProvider = createMockProvider(); // 正常 success 流
      const r = new ResilientProvider(okProvider, { maxRetries: 0 }, {
        failureThreshold: 100,
        cooldownMs: 0,
        idleTimeoutMs: 0, // 禁用
      });
      const events = await collectStream(r, [msg]);
      expect(events).toHaveLength(2); // TEXT + STOP，正常完成
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

// ── 空闲超时自适应（2026-10-07：写死 90s 把长推理打残）───────────────
//
// 事故链：思考型模型（DeepSeek-V4.1-Flash）经聚合中转时，推理阶段上游会长时间
// 一个 delta 都不推 —— 实测会话事件流出现 **430s 连续空洞**（上游把推理内容缓冲到
// 推理结束才一次性 flush）。原默认 90s 因此把"正常思考"反复误判成"挂起"：
// abort + 重试（每次从头生成、进度全丢），最终那次流结束时没有 finish_reason
// ⇒ stopReason 落空 ⇒ 被 finalize 默认成 end_turn ⇒ 静默截断、毫无提示。

describe('resolveIdleTimeoutMs：思考能力自适应 + 覆盖优先级', () => {
  // 动态 import：本文件顶部只静态引入了 ResilientProvider，避免为几个常量再改 import 段。
  let mod: typeof import('./resilient.js');
  const mk = (type: ProviderType, model: string): Provider =>
    ({ getProviderType: () => type, getModel: () => model } as unknown as Provider);

  it('思考型模型（目录声明 thinking）⇒ 10 分钟，且必须盖过实测 430s 静默', async () => {
    mod = await import('./resilient.js');
    // deepseek-flash 在模型目录里 capabilities.thinking = true
    expect(mod.resolveIdleTimeoutMs(mk('deepseek', 'deepseek-flash'))).toBe(mod.THINKING_IDLE_TIMEOUT_MS);
    expect(mod.THINKING_IDLE_TIMEOUT_MS).toBeGreaterThan(430_000);
    // 反向守卫：老的 90s 绝不能再当默认（否则事故复现）
    expect(mod.THINKING_IDLE_TIMEOUT_MS).not.toBe(90_000);
  });

  it('非思考型模型 ⇒ 2 分钟', async () => {
    mod = await import('./resilient.js');
    expect(mod.resolveIdleTimeoutMs(mk('openai', 'gpt-4o'))).toBe(mod.DEFAULT_IDLE_TIMEOUT_MS);
  });

  it('目录查不到的模型 ⇒ 保守走非思考值（不因查不到就放任无限等待）', async () => {
    mod = await import('./resilient.js');
    expect(mod.resolveIdleTimeoutMs(mk('deepseek', 'nonexistent-model-xyz'))).toBe(mod.DEFAULT_IDLE_TIMEOUT_MS);
  });

  it('显式值优先于自适应（含 0 = 禁用）', async () => {
    mod = await import('./resilient.js');
    expect(mod.resolveIdleTimeoutMs(mk('deepseek', 'deepseek-flash'), 12_345)).toBe(12_345);
    expect(mod.resolveIdleTimeoutMs(mk('deepseek', 'deepseek-flash'), 0)).toBe(0);
  });

  it('环境变量覆盖自适应，但显式值仍优先', async () => {
    mod = await import('./resilient.js');
    process.env[mod.STREAM_IDLE_TIMEOUT_ENV] = '7777';
    try {
      expect(mod.resolveIdleTimeoutMs(mk('deepseek', 'deepseek-flash'))).toBe(7777);
      expect(mod.resolveIdleTimeoutMs(mk('deepseek', 'deepseek-flash'), 1)).toBe(1);
    } finally {
      delete process.env[mod.STREAM_IDLE_TIMEOUT_ENV];
    }
  });

  it('构造期真的接线了：thinking 模型拿到的不是 DEFAULT_CB 里的兜底值', async () => {
    mod = await import('./resilient.js');
    const r = new ResilientProvider(mk('deepseek', 'deepseek-flash'));
    expect((r as unknown as { cbConfig: { idleTimeoutMs: number } }).cbConfig.idleTimeoutMs)
      .toBe(mod.THINKING_IDLE_TIMEOUT_MS);
  });
});
