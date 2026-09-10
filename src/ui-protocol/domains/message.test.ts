// ============================================================
// UI 协议层 — 消息域测试
// ============================================================
// 验证：
//  1. ProtocolOutputHandler 各回调 → message.* 事件到达 adapter
//  2. message.chat → 转发 loop.run + 广播 turn_info + state.update
//  3. message.chat 缺 content → 错误
//  4. message.stop → 转发 loop.interrupt
//  5. onPermissionRequest → permission.request 事件 + resolve 关联
//  6. onAskUser → message.ask_user 事件 + askUserResolve 应答
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { ProtocolOutputHandler, createMessageDomain } from './message.js';
import { PendingRequestRegistry, createPermissionDomain } from './permission.js';
import type { LoopLike } from './state.js';
import type { UiResponse } from '../types.js';

// ── mock Loop ──────────────────────────────────────────────

function makeLoop(runImpl?: (content: string) => Promise<void>): LoopLike & {
  runs: string[];
  interrupts: number;
} {
  const state = { runs: [] as string[], interrupts: 0 };
  const loop = {
    get runs() {
      return state.runs;
    },
    get interrupts() {
      return state.interrupts;
    },
    getTurnInfo: (tc: number, tu: number) => ({
      turnCount: tc,
      maxTurns: 20,
      tokensUsed: tu,
      maxContextTokens: 200000,
      sessionId: 'sess_1',
      compressCount: 0,
    }),
    getProviderRoutingInfo: () => ({ providerLabel: 'Anthropic', isLocal: false, mode: 'auto' }),
    getActiveProvider: () => ({ getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' }),
    run: async (content: string) => {
      state.runs.push(content);
      if (runImpl) await runImpl(content);
    },
    interrupt: () => {
      state.interrupts++;
    },
  };
  return loop as unknown as LoopLike & { runs: string[]; interrupts: number };
}

function setup(runImpl?: (content: string) => Promise<void>, historyProvider?: (sessionId: string, limit?: number) => Promise<import('../types.js').HistoryMessage[]>) {
  const loop = makeLoop(runImpl);
  const pending = new PendingRequestRegistry();
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();

  const emit = (type: string, payload?: unknown) => server.broadcast(type, payload);
  const messageDomain = createMessageDomain({
    loop,
    emit,
    pending,
    turnCount: () => 5,
    tokensUsed: () => 40000,
    historyProvider,
  });
  const permissionDomain = createPermissionDomain({ pending });
  server.registerDomain('message', messageDomain);
  server.registerDomain('permission', permissionDomain);
  server.attach(serverAdp);

  // ProtocolOutputHandler（供外部触发后端回调）
  const outputHandler = new ProtocolOutputHandler(emit, pending);

  const responses: UiResponse[] = [];
  const events: { type: string; payload?: unknown }[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
    else if (m.kind === 'event') events.push({ type: m.type, payload: m.payload });
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return { loop, pending, client, server, outputHandler, responses, events, flush };
}

describe('ProtocolOutputHandler 事件广播', () => {
  it('text / thinking / tool_use / tool_result / diff / status / turn_start / flush / interrupt 到达 adapter', async () => {
    const { outputHandler, events, flush } = setup();

    outputHandler.onText('hello');
    outputHandler.onThinking('thinking...');
    outputHandler.onToolUse('bash', 'run ls', 't1');
    outputHandler.onToolResult('ok', false, 't1');
    outputHandler.onDiff('t1', 'a.ts', [{ kind: '+', text: 'x' }]);
    outputHandler.onStatus('working', 'info');
    outputHandler.onTurnStart();
    outputHandler.onFlush();
    outputHandler.onInterrupt();
    await flush();

    const types = events.map((e) => e.type);
    expect(types).toContain('message.text');
    expect(types).toContain('message.thinking');
    expect(types).toContain('message.tool_use');
    expect(types).toContain('message.tool_result');
    expect(types).toContain('message.diff');
    expect(types).toContain('message.status');
    expect(types).toContain('message.turn_start');
    expect(types).toContain('message.flush');
    expect(types).toContain('message.interrupt');

    expect(events.find((e) => e.type === 'message.text')?.payload).toEqual({ content: 'hello' });
    expect(events.find((e) => e.type === 'message.tool_use')?.payload).toMatchObject({
      id: 't1', name: 'bash', inputSummary: 'run ls',
    });
    expect(events.find((e) => e.type === 'message.diff')?.payload).toMatchObject({
      id: 't1', filePath: 'a.ts',
    });
  });

  it('message.chat 转发 loop.run + 广播 turn_info + state.update', async () => {
    const { loop, client, responses, events, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'message.chat', params: { content: '你好' } });
    await flush();

    // loop.run 被调用
    expect(loop.runs).toEqual(['你好']);
    // 响应 ok
    expect(responses.find((r) => r.id === 'r1')).toMatchObject({ id: 'r1', ok: true });
    // turn_info + state.update 事件
    expect(events.some((e) => e.type === 'message.turn_info')).toBe(true);
    expect(events.some((e) => e.type === 'state.update')).toBe(true);
    const stateUpdate = events.find((e) => e.type === 'state.update')!.payload as any;
    expect(stateUpdate).toMatchObject({ model: 'claude-sonnet-5', turnCount: 5, tokensUsed: 40000 });
  });

  it('message.chat 缺 content → 返回错误，不调 loop.run', async () => {
    const { loop, client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'message.chat', params: {} });
    await flush();
    const resp = responses.find((r) => r.id === 'r1')!;
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('content');
    expect(loop.runs).toHaveLength(0);
  });

  it('message.stop 转发 loop.interrupt', async () => {
    const { loop, client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'message.stop' });
    await flush();
    expect(loop.interrupts).toBe(1);
    expect(responses.find((r) => r.id === 'r1')).toMatchObject({ ok: true });
  });
});

describe('message.history 历史消息', () => {
  const history = [
    { type: 'user_input', content: '你好', timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'text', content: 'hi', timestamp: '2026-01-01T00:00:01.000Z' },
    { type: 'tool_call', name: 'bash', id: 't1', input: { cmd: 'ls' }, timestamp: '2026-01-01T00:00:02.000Z' },
  ];

  it('message.history 转发 historyProvider 并返回消息数组', async () => {
    const provider = async (sessionId: string, limit?: number) => {
      expect(sessionId).toBe('sess_1');
      expect(limit).toBe(10);
      return history as import('../types.js').HistoryMessage[];
    };
    const { client, responses, flush } = setup(undefined, provider);
    client.send({
      kind: 'request', id: 'r1', method: 'message.history',
      params: { sessionId: 'sess_1', limit: 10 },
    });
    await flush();
    const resp = responses.find((r) => r.id === 'r1')!;
    if (!resp.ok) console.log('DIAG resp.error =', JSON.stringify((resp as any).error));
    expect(resp.ok).toBe(true);
    const result = (resp as any).result as { messages: unknown[] };
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({ type: 'user_input', content: '你好' });
    expect(result.messages[2]).toMatchObject({ type: 'tool_call', name: 'bash', id: 't1' });
  });

  it('message.history 缺 sessionId → 错误', async () => {
    const provider = async () => [];
    const { client, responses, flush } = setup(undefined, provider);
    client.send({ kind: 'request', id: 'r1', method: 'message.history', params: {} });
    await flush();
    const resp = responses.find((r) => r.id === 'r1')!;
    expect(resp.ok).toBe(false);
    expect((resp as any).error.message).toContain('sessionId');
  });

  it('message.history 未接线 historyProvider → 明确错误', async () => {
    const { client, responses, flush } = setup();
    client.send({
      kind: 'request', id: 'r1', method: 'message.history',
      params: { sessionId: 'sess_1' },
    });
    await flush();
    const resp = responses.find((r) => r.id === 'r1')!;
    expect(resp.ok).toBe(false);
    expect((resp as any).error.message).toContain('historyProvider');
  });
});

describe('permission / ask_user 请求-应答关联', () => {
  it('onPermissionRequest → permission.request 事件；permission.resolve 关联应答', async () => {
    const { outputHandler, pending, client, events, flush } = setup();

    // 触发 permission 请求（返回 Promise，等待应答）
    const promise = outputHandler.onPermissionRequest('write', { file: '/tmp/a' });
    await flush();

    // permission.request 事件已广播（带 id）
    const req = events.find((e) => e.type === 'permission.request');
    expect(req).toBeTruthy();
    const reqId = (req!.payload as any).id;
    expect((req!.payload as any)).toMatchObject({ toolName: 'write', input: { file: '/tmp/a' } });
    expect(pending.has(reqId)).toBe(true);

    // 客户端通过 permission.resolve 应答
    client.send({ kind: 'request', id: 'x1', method: 'permission.resolve', params: { id: reqId, result: 'yes' } });
    const result = await promise; // Promise 应被 resolve
    expect(result).toBe('yes');
    expect(pending.has(reqId)).toBe(false);
  });

  it('onAskUser → message.ask_user 事件；askUserResolve 应答返回 JSON 答案', async () => {
    const { outputHandler, pending, client, events, flush } = setup();

    const promise = outputHandler.onAskUser([{ question: '选哪个?', options: ['A', 'B'] }]);
    await flush();

    const req = events.find((e) => e.type === 'message.ask_user');
    expect(req).toBeTruthy();
    const reqId = (req!.payload as any).id;
    expect((req!.payload as any).questions).toHaveLength(1);

    // 客户端通过 message.askUserResolve 应答
    client.send({
      kind: 'request',
      id: 'x1',
      method: 'message.askUserResolve',
      params: { id: reqId, answer: '{"0":"A"}' },
    });
    const answer = await promise;
    expect(answer).toBe('{"0":"A"}');
    expect(pending.has(reqId)).toBe(false);
  });

  it('permission.resolve 用不存在的 id → 错误', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'x1', method: 'permission.resolve', params: { id: 'nope', result: 'yes' } });
    await flush();
    expect(responses.find((r) => r.id === 'x1')).toMatchObject({ ok: false });
    expect((responses.find((r) => r.id === 'x1')!.error as any).message).toContain('not found');
  });
});
