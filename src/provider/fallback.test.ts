import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FallbackProviderChain } from './fallback.js';
import type { FallbackCandidate } from './fallback.js';
import { ProviderProbe } from './probe.js';
import type { Provider } from './interface.js';
import type { ProviderFactoryMeta } from './provider-meta.js';
import type { ProviderType } from '../types.js';

// ─── Mock helpers ───────────────────────────────────────────────────

function makeMeta(overrides: Partial<ProviderFactoryMeta> & { id: string }): ProviderFactoryMeta {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'test-model',
    envKey: 'X_API_KEY',
    ...rest,
  };
}

function makeProvider(type: string, model: string, opts: { fail?: boolean } = {}): Provider {
  return {
    getProviderType: () => type as ProviderType,
    getModel: () => model,
    getCapabilities: () => ({ toolCalling: false, streaming: true, adapterSupport: false, maxContextTokens: 4096, isLocal: false, vision: false }),
    async *createStream() {
      if (opts.fail) throw new Error(`fail:${type}/${model}`);
      yield { type: 'TEXT', content: 'ping' };
      yield { type: 'STOP', reason: 'stop' };
    },
  };
}

/** 行为可在测试中途切换的 provider（主恢复场景） */
function makeTogglableProvider(type: string, model: string): Provider & { setFail(v: boolean): void } {
  let fail = true;
  const p = {
    getProviderType: () => type as ProviderType,
    getModel: () => model,
    getCapabilities: () => ({ toolCalling: false, streaming: true, adapterSupport: false, maxContextTokens: 4096, isLocal: false, vision: false }),
    setFail(v: boolean) { fail = v; },
    async *createStream() {
      if (fail) throw new Error(`fail:${type}/${model}`);
      yield { type: 'TEXT' as const, content: 'ping' };
      yield { type: 'STOP' as const, reason: 'stop' };
    },
  };
  return p;
}

function candidate(meta: ProviderFactoryMeta, apiKey: string, opts: { fail?: boolean } = {}): FallbackCandidate {
  return {
    meta,
    apiKey,
    create: () => makeProvider(meta.id, meta.defaultModel, opts),
  };
}

async function drain(chain: FallbackProviderChain): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const e of chain.createStream([])) events.push(e);
  return events;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('FallbackProviderChain 动态候选探测', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('主成功：候选不实例化，探测已启动并落缓存', async () => {
    const probe = new ProviderProbe();
    const primary = makeProvider('anthropic', 'claude-1');
    let createCalled = 0;
    const chain = new FallbackProviderChain({
      providers: [primary],
      candidates: [{
        meta: makeMeta({ id: 'openai' }),
        apiKey: 'sk-1',
        create: () => { createCalled++; return makeProvider('openai', 'gpt-1'); },
      }],
      probe,
    });

    const events = await drain(chain);
    expect(events.some((e) => (e as { type: string }).type === 'TEXT')).toBe(true);
    expect(createCalled).toBe(0);
    // 探测请求已发出（fire-and-forget 落缓存），等待微任务完成后复用缓存
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('主失败 → 仅探测 ok 的候选懒实例化入链', async () => {
    const probe = new ProviderProbe();
    const primary = makeProvider('anthropic', 'claude-1', { fail: true });
    let createCalled = 0;
    const chain = new FallbackProviderChain({
      providers: [primary],
      candidates: [{
        meta: makeMeta({ id: 'openai' }),
        apiKey: 'sk-1',
        create: () => { createCalled++; return makeProvider('openai', 'gpt-1'); },
      }],
      probe,
    });

    const events = await drain(chain);
    expect(events.some((e) => (e as { type: string }).type === 'TEXT')).toBe(true);
    expect(createCalled).toBe(1); // 懒实例化发生在 create 闭包内
  });

  it('探测 unavailable 的候选被跳过，聚合错误含标注，且不实例化', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    const probe = new ProviderProbe();
    const primary = makeProvider('anthropic', 'claude-1', { fail: true });
    let createCalled = 0;
    const chain = new FallbackProviderChain({
      providers: [primary],
      candidates: [{
        meta: makeMeta({ id: 'openai' }),
        apiKey: 'sk-bad',
        create: () => { createCalled++; return makeProvider('openai', 'gpt-1'); },
      }],
      probe,
    });

    await expect(async () => {
      for await (const e of chain.createStream([])) { void e; }
    }).rejects.toThrow(/skipped-unavailable\(401\)/);
    expect(createCalled).toBe(0);
  });

  it('探测 ok 但真实流失败 → invalidate 缓存 + 聚合错误', async () => {
    const probe = new ProviderProbe();
    const invalidateSpy = vi.spyOn(probe, 'invalidate');
    const primary = makeProvider('anthropic', 'claude-1', { fail: true });
    const chain = new FallbackProviderChain({
      providers: [primary],
      candidates: [candidate(makeMeta({ id: 'openai' }), 'sk-1', { fail: true })],
      probe,
    });

    await expect(async () => {
      for await (const e of chain.createStream([])) { void e; }
    }).rejects.toThrow(/failed/);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('降级后主恢复 → onRecover 触发；切换时 onFallback 触发', async () => {
    const probe = new ProviderProbe();
    const onFallback = vi.fn();
    const onRecover = vi.fn();
    const primary = makeTogglableProvider('anthropic', 'claude-1');
    const chain = new FallbackProviderChain({
      providers: [primary],
      candidates: [candidate(makeMeta({ id: 'openai' }), 'sk-1')],
      probe,
      onFallback,
      onRecover,
    });

    // 第一轮：主失败 → 候选成功（降级）
    primary.setFail(true);
    await drain(chain);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onRecover).not.toHaveBeenCalled();
    expect(chain.isOnFallback).toBe(true);
    expect(chain.getActiveType()).toBe('openai');

    // 第二轮：主恢复 → onRecover
    primary.setFail(false);
    await drain(chain);
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(chain.isOnFallback).toBe(false);
  });

  it('全部失败 → 聚合错误列出静态链与候选', async () => {
    const probe = new ProviderProbe();
    const primary = makeProvider('anthropic', 'claude-1', { fail: true });
    const chain = new FallbackProviderChain({
      providers: [primary],
      candidates: [candidate(makeMeta({ id: 'openai' }), 'sk-1', { fail: true })],
      probe,
    });

    await expect(async () => {
      for await (const e of chain.createStream([])) { void e; }
    }).rejects.toThrow(/All 2 provider\(s\) failed/);
  });

  it('降级链全不可用 → 兜底回主 provider，成功则继续（长任务不断）', async () => {
    const probe = new ProviderProbe();
    const onFallback = vi.fn();
    const onRecover = vi.fn();
    let primaryCalls = 0;
    const primary: Provider = {
      getProviderType: () => 'anthropic' as ProviderType,
      getModel: () => 'claude-1',
      getCapabilities: () => ({ toolCalling: false, streaming: true, adapterSupport: false, maxContextTokens: 4096, isLocal: false, vision: false }),
      async *createStream() {
        primaryCalls++;
        // 401 非可重试 → ResilientProvider 立即失败，走降级 + 兜底路径
        if (primaryCalls === 1) throw new Error('HTTP 401 Unauthorized');
        yield { type: 'TEXT' as const, content: 'ping' };
        yield { type: 'STOP' as const, reason: 'stop' };
      },
    };
    const chain = new FallbackProviderChain({
      providers: [primary],
      candidates: [candidate(makeMeta({ id: 'openai' }), 'sk-1', { fail: true })],
      probe,
      onFallback,
      onRecover,
    });

    const events = await drain(chain);
    expect(events.some((e) => (e as { type: string }).type === 'TEXT')).toBe(true);
    expect(primaryCalls).toBe(2); // 主链 1 次 + 兜底 1 次
    expect(chain.getActiveType()).toBe('anthropic'); // 回到最开始那个
    expect(chain.getActiveModel()).toBe('claude-1');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('兜底主 provider 仍失败 → 聚合错误含 back-to-primary 标注', async () => {
    const probe = new ProviderProbe();
    const primary = makeProvider('anthropic', 'claude-1', { fail: true });
    const chain = new FallbackProviderChain({
      providers: [primary],
      candidates: [candidate(makeMeta({ id: 'openai' }), 'sk-1', { fail: true })],
      probe,
    });

    await expect(async () => {
      for await (const e of chain.createStream([])) { void e; }
    }).rejects.toThrow(/back-to-primary/);
  });
});
