// ============================================================
// UI 协议层 — 状态域测试
// ============================================================
// 验证：
//  1. state.get 返回完整快照（model/provider/mode/token/contextUsage/cache/plan）
//  2. contextUsagePct 计算正确（<100% / 超限截断到 100%）
//  3. provider 路由信息合并进快照
//  4. state.subscribe 返回当前快照
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createStateDomain, calcContextUsagePct, type LoopLike, type StateDomainOptions } from './state.js';
import type { UiResponse } from '../types.js';

// ── mock Loop ──────────────────────────────────────────────

function makeLoop(overrides?: Partial<LoopLike>): LoopLike {
  return {
    getTurnInfo: (tc: number, tu: number) => ({
      turnCount: tc,
      maxTurns: 20,
      tokensUsed: tu,
      maxContextTokens: 200000,
      sessionId: 'sess_1',
      compressCount: 2,
      planStepsTotal: 3,
      planStepsDone: 1,
      cacheHitTokens: 1000,
      cacheMissTokens: 500,
      cacheHitRate: 66.7,
      cacheHistory: [
        { turn: 1, timestamp: 't', inputTokens: 1500, outputTokens: 300, hitTokens: 1000, missTokens: 500, hitRate: 66.7 },
      ],
    }),
    getProviderRoutingInfo: () => ({ providerLabel: 'main', isLocal: false, mode: 'auto' }),
    getActiveProvider: () => ({
      getProviderType: () => 'deepseek',
      getModel: () => 'deepseek-v4-flash',
    }),
    ...overrides,
  };
}

function setup(loop: LoopLike, opts?: Partial<StateDomainOptions>) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  const domain = createStateDomain({
    loop,
    turnCount: () => 5,
    tokensUsed: () => 40000,
    ...opts,
  });
  server.registerDomain('state', domain);
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return { client, responses, flush };
}

describe('状态域', () => {
  it('state.get 返回完整快照', async () => {
    const loop = makeLoop();
    const { client, responses, flush } = setup(loop);
    client.send({ kind: 'request', id: 'r1', method: 'state.get' });
    await flush();

    const snap = responses[0].result as any;
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect(snap).toMatchObject({
      sessionId: 'sess_1',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      providerLabel: 'deepseek', // providerLabel 语义为 provider 类型名（active provider type），非通道名
      isLocal: false,
      routeMode: 'auto',
      mode: 'auto',
      turnCount: 5,
      maxTurns: 20,
      tokensUsed: 40000,
      maxContextTokens: 200000,
      compressCount: 2,
      planStepsTotal: 3,
      planStepsDone: 1,
      cacheHitTokens: 1000,
      cacheMissTokens: 500,
      cacheHitRate: 66.7,
    });
    expect(snap.contextUsagePct).toBe(20); // 40000/200000 = 20%
    expect(snap.updatedAt).toBeTruthy();
    expect(snap.cacheHistory).toHaveLength(1);
  });

  it('contextUsagePct 计算：正常百分比', () => {
    expect(calcContextUsagePct(20000, 200000)).toBe(10);
    expect(calcContextUsagePct(50000, 200000)).toBe(25);
    expect(calcContextUsagePct(0, 200000)).toBe(0);
  });

  it('contextUsagePct 计算：超限截断到 100%', () => {
    expect(calcContextUsagePct(250000, 200000)).toBe(100);
    expect(calcContextUsagePct(300000, 200000)).toBe(100);
  });

  it('contextUsagePct 计算：maxContext 为 0/未定义返回 0', () => {
    expect(calcContextUsagePct(10000, 0)).toBe(0);
    expect(calcContextUsagePct(10000, NaN)).toBe(0);
  });

  it('provider 路由信息缺省时回退到 active provider', async () => {
    const loop = makeLoop({
      getProviderRoutingInfo: () => null, // 路由信息缺失
    });
    const { client, responses, flush } = setup(loop);
    client.send({ kind: 'request', id: 'r1', method: 'state.get' });
    await flush();
    const snap = responses[0].result as any;
    expect(snap.providerLabel).toBe('deepseek'); // 回退到 active provider type
    expect(snap.isLocal).toBe(false);
  });

  it('state.get 快照含 sessionDir（注入 sessionDirProvider 时）', async () => {
    const loop = makeLoop();
    const { client, responses, flush } = setup(loop, {
      sessionDirProvider: (sid) => `/sessions/${sid}/dir`,
    });
    client.send({ kind: 'request', id: 'r1', method: 'state.get' });
    await flush();
    const snap = responses[0].result as any;
    expect(snap.sessionDir).toBe('/sessions/sess_1/dir'); // sessionId 来自 loop turnInfo
  });

  it('state.get 快照缺省不含 sessionDir（未注入 provider 时）', async () => {
    const loop = makeLoop();
    const { client, responses, flush } = setup(loop);
    client.send({ kind: 'request', id: 'r1', method: 'state.get' });
    await flush();
    const snap = responses[0].result as any;
    expect(snap.sessionDir).toBeUndefined();
  });

  it('state.subscribe 返回当前快照', async () => {
    const loop = makeLoop();
    const { client, responses, flush } = setup(loop);
    client.send({ kind: 'request', id: 'r1', method: 'state.subscribe' });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect((responses[0].result as any).snapshot).toBeTruthy();
    expect((responses[0].result as any).snapshot.model).toBe('deepseek-v4-flash');
  });
});
