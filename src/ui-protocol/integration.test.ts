// ============================================================
// UI 协议层 — 进程内集成测试（UiProtocolSession）
// ============================================================
// 模拟真实接入流程：UiProtocolSession + InProcAdapter，
// 验证核心事件链：
//   client 发 message.chat
//     → createMessageDomain.chat 调 loop.run
//     → loop 内部用注入的 ProtocolOutputHandler 输出
//     → server.broadcast(message.text / turn_info / state.update)
//     → InProcAdapter → client 收到事件
//
// 同时验证 permission 请求-应答闭环（onPermissionRequest →
// permission.request → permission.resolve）。
// ============================================================

import { describe, it, expect } from 'vitest';
import { InProcAdapter } from './index.js';
// 装配器在 channels 层（依赖 AgentFactory/ChannelOutputHandler），
// 协议层 index.ts 保持纯净不 re-export，测试直接从来源导入。
import { UiProtocolSession } from '../channels/builtin/ui-protocol-session.js';
import type { UiProtocolSessionBackend } from '../channels/builtin/ui-protocol-session.js';
import type { AgentFactory, ChannelOutputHandler } from '../channels/interface.js';
import type { ProtocolOutputHandler } from './domains/message.js';
import type { UiEvent, UiResponse } from './types.js';

// ── 基础 mock backend（config/session/model/command 的最小实现）────

function makeBaseBackend(): UiProtocolSessionBackend {
  return {
    configCenter: {
      get: <T = unknown>(path: string): T => {
        if (path === 'session.maxTurns') return 100 as T;
        return undefined as T;
      },
      getAll: () => ({ session: { maxTurns: 100 } }),
      set: () => {},
      merge: () => {},
      reset: () => {},
      watch: () => () => {},
    } as never,
    sessionStore: {
      create: async () => ({ id: 's1', projectKey: 'p', createdAt: 't', updatedAt: 't' }),
      resume: async () => ({ id: 's1', projectKey: 'p', createdAt: 't', updatedAt: 't' }),
      list: async () => [],
      getLatest: async () => null,
      getLatestByChannel: async () => null,
      getSessionDir: () => '/tmp',
    } as never,
    registry: {
      listChannels: () => [],
      upsertChannel: () => {},
      removeChannel: () => {},
      setChannelModel: () => {},
      resetChannelModel: () => {},
      getChannelInfo: () => null,
      getMainProvider: () => null,
      getProviderType: () => 'anthropic',
      getModel: () => 'claude-sonnet-5',
      setThinking: () => {},
    } as never,
    manager: { switchProvider: () => {} } as never,
    commandRegistry: {
      getByCategory: () => new Map(),
      find: () => undefined,
    } as never,
    listProvidersMeta: () => [
      { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5' },
    ],
  };
}

/** 建立进程内链路：UiProtocolSession + InProcAdapter，返回收发 helper */
function setup(backendOverrides: Partial<UiProtocolSessionBackend> = {}) {
  // 创建可注入 outputHandler 的 mock loop（模拟 AgentLoop 用外部 handler 输出）
  const loopState: { outputHandler: ProtocolOutputHandler | null } = { outputHandler: null };
  const loop = {
    getTurnInfo: (tc: number, tu: number) => ({
      turnCount: tc,
      maxTurns: 20,
      tokensUsed: tu,
      maxContextTokens: 200000,
      sessionId: 'sess_integ',
      compressCount: 0,
    }),
    getProviderRoutingInfo: () => ({ providerLabel: 'Anthropic', isLocal: false, mode: 'auto' }),
    getActiveProvider: () => ({ getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' }),
    async run(content: string): Promise<void> {
      // 模拟 AgentLoop：运行中通过注入的 outputHandler 输出
      loopState.outputHandler?.onThinking(`思考: ${content}`);
      loopState.outputHandler?.onText(`回复: ${content}`);
      loopState.outputHandler?.onStatus('完成', 'info');
    },
    turnNumber: 0,
    contextTokensUsed: 0,
  };

  // mock agentFactory：把 outputHandler 注入 loop 状态（模拟真实 AgentLoop.setOutputHandler）
  const agentFactory: AgentFactory = {
    createAgent: async ({ outputHandler }) => {
      loopState.outputHandler = outputHandler as ProtocolOutputHandler;
      return { loop: loop as never };
    },
  };

  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);

  const session = new UiProtocolSession(serverAdp, 'sess_integ', {
    ...makeBaseBackend(),
    ...backendOverrides,
  });
  // 惰性初始化（内部 attach + loop 注入），测试需 await
  const initialized = session.initialize(agentFactory).then(() => session);

  const responses: UiResponse[] = [];
  const events: UiEvent[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
    else if (m.kind === 'event') events.push(m);
  });

  const waitForEvent = async (
    type: string,
    pred?: (p: unknown) => boolean,
    timeout = 3000,
  ): Promise<UiEvent> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = events.find((e) => e.type === type && (!pred || pred(e.payload)));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timeout waiting for event "${type}"`);
  };

  return { initialized, result: session, client, responses, events, waitForEvent };
}

describe('进程内集成：chat → turn_info → text 事件链', () => {
  it('message.chat 触发 loop.run，client 收到 thinking/text/status/turn_info/state.update', async () => {
    const { initialized, client, waitForEvent } = setup();
    await initialized;

    client.send({ kind: 'request', id: 'chat1', method: 'message.chat', params: { content: '你好' } });

    // 事件链：thinking → text → status（loop 内输出）→ turn_info → state.update
    const thinking = await waitForEvent('message.thinking');
    expect(thinking.payload).toEqual({ content: '思考: 你好' });

    const text = await waitForEvent('message.text');
    expect(text.payload).toEqual({ content: '回复: 你好' });

    await waitForEvent('message.status', (p) => (p as any).message === '完成');

    const turnInfo = await waitForEvent('message.turn_info');
    expect((turnInfo.payload as any).sessionId).toBe('sess_integ');

    const stateUpdate = await waitForEvent('state.update');
    expect((stateUpdate.payload as any)).toMatchObject({
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      sessionId: 'sess_integ',
    });
  });

  it('message.chat 的 response 在事件流之后返回 ok:true', async () => {
    const { initialized, client, responses } = setup();
    await initialized;
    client.send({ kind: 'request', id: 'chat2', method: 'message.chat', params: { content: 'hi' } });

    const start = Date.now();
    let resp: UiResponse | undefined;
    while (Date.now() - start < 3000) {
      resp = responses.find((r) => r.id === 'chat2');
      if (resp) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(resp).toMatchObject({ id: 'chat2', ok: true });
  });

  it('permission 闭环：onPermissionRequest → permission.request → permission.resolve', async () => {
    const { initialized, result, client, waitForEvent, responses } = setup();
    await initialized;

    // 触发 permission 请求（模拟后端要执行危险工具）
    const promise = result.outputHandler.onPermissionRequest('write', { file: '/tmp/a' });
    const req = await waitForEvent('permission.request');
    const reqId = (req.payload as any).id;
    expect(req.payload).toMatchObject({ toolName: 'write', input: { file: '/tmp/a' } });

    // client 应答
    client.send({ kind: 'request', id: 'perm1', method: 'permission.resolve', params: { id: reqId, result: 'yes' } });
    const result2 = await promise;
    expect(result2).toBe('yes');

    // resolve 响应
    const start = Date.now();
    let resp: UiResponse | undefined;
    while (Date.now() - start < 3000) {
      resp = responses.find((r) => r.id === 'perm1');
      if (resp) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(resp).toMatchObject({ id: 'perm1', ok: true });
  });

  it('状态查询：client 发 state.get 收到完整快照', async () => {
    const { initialized, client, responses } = setup();
    await initialized;
    client.send({ kind: 'request', id: 's1', method: 'state.get' });

    const start = Date.now();
    let resp: UiResponse | undefined;
    while (Date.now() - start < 3000) {
      resp = responses.find((r) => r.id === 's1');
      if (resp) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(resp).toMatchObject({ id: 's1', ok: true });
    expect((resp!.result as any)).toMatchObject({ model: 'claude-sonnet-5', provider: 'anthropic' });
  });
});
