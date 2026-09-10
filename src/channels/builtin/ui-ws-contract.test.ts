// ============================================================
// TUI 远程 / 桌面端 WebSocket 契约测试（迁移验收）
// ============================================================
// 背景：/tui 与 /desktop 端点原本走 TuiWsSession（旧协议：
//   {type:'chat'|'stop'|'permission'} 简单消息 + WebUIOutputHandler
//   直发回调）。本次统一迁移到 UiWsSession（统一 ui-protocol 7 域
//   协议，与 /ui、TUI 本地模式完全对称）。
//
// 本文件是迁移的契约测试：以旧协议的能力清单为 spec，断言
// 新实现（UiWsSession 经真实 WebSocket 链路）对每项能力都有
// 等价实现。迁移前可作为验收标准，迁移后作为回归保护。
//
// 旧协议能力 → 新协议映射：
//   connected                 → ui.connected 事件
//   chat → text/thinking/tool_use/tool_result/status/turn_info
//                             → message.chat 请求 + message.* 事件流
//   stop（旧实现为空操作，AgentLoop 无 requestStop）
//                             → message.stop → loop.interrupt()（升级为有效停止）
//   permission 请求/应答      → permission.request 事件 + permission.resolve
//   error                     → message.error 事件 + 错误响应（ok:false）
//   （迁移后延伸覆盖新域）companion → companion.get/activate/deactivate
//                             （Router 生命周期闭环：switchRouter → syncRouter → 钩子）
// ============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { UiWsSession } from './ui-ws-session.js';
import type { UiProtocolSessionBackend } from './ui-protocol-session.js';
import type { AgentFactory } from '../interface.js';
import type { ProtocolOutputHandler } from '../../ui-protocol/domains/message.js';
import type { LoopLike } from '../../ui-protocol/domains/state.js';
import { UI_EVENT } from '../../events.js';

// ── 隔离真实 home 目录（companion 域会扫描 ~/.agent/companion/ 并写 .last-character）──
// 目录不存在时域代码自身有 catch 兜底；契约用例均显式传 character，不依赖文件系统内容。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const path = await import('node:path');
  const home = path.join(actual.tmpdir(), `hyacinth-contract-home-${process.pid}`);
  const homedir = () => home;
  return { ...actual, default: { ...actual, homedir }, homedir } as typeof actual;
});

// ── 契约端点：与 http-webhook 的 /tui /desktop 一致 ──────────

const CONTRACT_PATHS = ['/tui', '/desktop'];

// ── fake loop：模拟 AgentLoop 使用注入的 ProtocolOutputHandler ──

interface LoopState {
  outputHandler: ProtocolOutputHandler | null;
  interrupted: number;
  runCalls: string[];
  switchCalls: string[];
  pendingTaskName: string | null;
  schedulerAdds: Array<{ name: string; time: string }>;
}

/**
 * companion 域的 fake 状态（makeLoop 与 makeBackend 共享同一份，构成闭环）：
 *   - globalName：switchRouter 的副作用（对应全局 _activeRouterName）
 *   - activeName：loop.activeRouter.name（syncRouter 前二者可能不同步）
 *   - 复刻真实 syncRouter：名字相同直接 return，否则 onDeactivate → 切换 → onActivate
 */
interface CompanionFake {
  characters: string[];
  switchCalls: string[];
  syncCalls: number;
  activateCalls: number;
  deactivateCalls: number;
  clearCacheCalls: number;
  setCharacterCalls: string[];
  globalName: string;
  activeName: string;
  characterName: string;
}

function makeLoop(state: LoopState, companion: CompanionFake): LoopLike {
  const switchSession = async (dir: string): Promise<void> => {
    state.switchCalls.push(dir);
  };
  // CompanionRouter.onActivate 的等价物：切换 session 到陪伴目录
  const runActivate = async (l: unknown) => {
    companion.activateCalls += 1;
    await (l as { switchSession(d: string): Promise<void> }).switchSession(
      `/tmp/companion/${companion.characterName}`,
    );
  };
  return {
    getTurnInfo: (tc: number, tu: number) => ({
      turnCount: tc,
      maxTurns: 20,
      tokensUsed: tu,
      maxContextTokens: 200000,
      sessionId: 'sess_contract',
      compressCount: 0,
    }),
    getProviderRoutingInfo: () => ({ providerLabel: 'Test', isLocal: false, mode: 'auto' }),
    getActiveProvider: () => ({ getProviderType: () => 'test', getModel: () => 'm1' }),
    async run(content: string): Promise<void> {
      state.runCalls.push(content);
      const h = state.outputHandler;
      if (!h) return;
      h.onThinking(`思考: ${content}`);
      h.onText(`回复: ${content}`);
      h.onStatus('完成', 'info');
    },
    interrupt(): void {
      state.interrupted += 1;
    },
    // session.switch 用：记录被切换的会话目录
    switchSession,
    // ── companion 域用：Router 生命周期闭环 ──
    sessionDir: '/tmp/sess_contract',
    get activeRouter() {
      if (companion.activeName !== 'companion') {
        return { name: 'normal', activeCompanionName: '' };
      }
      return {
        name: 'companion',
        get activeCompanionName() {
          return companion.characterName;
        },
        set activeCompanionName(v: string) {
          companion.characterName = v;
        },
        onActivate: runActivate,
        onDeactivate: async () => {
          companion.deactivateCalls += 1;
        },
      };
    },
    async syncRouter(): Promise<void> {
      companion.syncCalls += 1;
      if (companion.activeName === companion.globalName) return;
      if (companion.activeName === 'companion') companion.deactivateCalls += 1;
      companion.activeName = companion.globalName;
      if (companion.activeName === 'companion') await runActivate({ switchSession });
    },
    // model.sources 用：各角色模型来源
    getModelSources: () => ({ assessment: 'main', planning: 'local' }),
    // schedule.runtime 用：当前执行中的调度任务名（getter 动态读取 state）
    get pendingTaskName() {
      return state.pendingTaskName;
    },
    // schedule.list/addDaily 用：fake 调度器（LoopLike 无此字段，断言绕过类型）
    getScheduler: () => ({
      getTasks: () => [],
      getStatus: () => ({ running: false, taskCount: 0, enabledTaskCount: 0 }),
      addTask: async (name: string, _st: string, schedule: { time?: string }) => {
        state.schedulerAdds.push({ name, time: schedule.time ?? '' });
        return { ok: true };
      },
    }),
  } as unknown as LoopLike;
}

/**
 * fake agentFactory：模拟真实装配——UiProtocolSession.initialize 传入
 * ProtocolOutputHandler，loop 用它输出（等价 AgentLoop 持有 outputHandler）。
 */
function makeAgentFactory(state: LoopState, companion: CompanionFake): AgentFactory {
  return {
    createAgent: async (options) => {
      state.outputHandler = options.outputHandler as unknown as ProtocolOutputHandler;
      return {
        loop: makeLoop(state, companion),
        sessionDir: '/tmp/sess_contract',
        sessionManager: {} as never,
        toolRegistry: {} as never,
        skillRegistry: {} as never,
      } as never;
    },
  };
}

// ── 基础 backend stub（config/session/model/command 最小实现）──

/** 新域（state.stats / kb / process / orchestrator）的 fake 状态，测试可断言 */
interface BackendExtras {
  kb: {
    enabled: boolean;
    zone4Enabled: boolean;
    setCalls: Array<{ zone4?: boolean; enabled?: boolean }>;
  };
  proc: { kills: string[]; listCalls: number };
  statsCalls: string[];
  orchestrator: { active: boolean; setCalls: Array<boolean> };
  companion: CompanionFake;
}

function makeBackend(extras: BackendExtras): UiProtocolSessionBackend {
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
      // session.switch 的 ensureExists 需要 s1 存在
      list: async () => [{ id: 's1', projectKey: 'p', createdAt: 't', updatedAt: 't' }],
      getLatest: async () => null,
      getLatestByChannel: async () => null,
      getSessionDir: (id: string) => `/tmp/${id}`,
    } as never,
    registry: {
      listChannels: () => [],
      upsertChannel: () => {},
      removeChannel: () => {},
      setChannelModel: () => {},
      resetChannelModel: () => {},
      getChannelInfo: () => null,
      getMainProvider: () => null,
      getProviderType: () => 'test',
      getModel: () => 'm1',
      setThinking: () => {},
    } as never,
    manager: { switchProvider: () => {} } as never,
    commandRegistry: {
      getByCategory: () => new Map(),
      find: () => undefined,
    } as never,
    listProvidersMeta: () => [{ id: 'test', name: 'Test', defaultModel: 'm1' }],
    // ── state.stats / kb / process 域 ──
    statsProvider: async (sid: string) => {
      extras.statsCalls.push(sid);
      return { sessionId: sid, turn_count: 3, current_context_tokens: 500 };
    },
    getKb: () => ({
      get enabled() {
        return extras.kb.enabled;
      },
      get zone4Enabled() {
        return extras.kb.zone4Enabled;
      },
      enable: () => {
        extras.kb.enabled = true;
        extras.kb.setCalls.push({ enabled: true });
      },
      disable: () => {
        extras.kb.enabled = false;
        extras.kb.setCalls.push({ enabled: false });
      },
      setZone4Enabled: (v: boolean) => {
        extras.kb.zone4Enabled = v;
        extras.kb.setCalls.push({ zone4: v });
      },
    }),
    getRegistry: () => ({
      list: () => {
        extras.proc.listCalls += 1;
        return [
          {
            handle: 'h1',
            name: 'dev-server',
            command: 'npm run dev',
            pid: 123,
            status: 'running' as const,
            startTime: 't0',
            outputSize: 10,
          },
        ];
      },
      kill: async (h: string) => {
        extras.proc.kills.push(h);
        return true;
      },
    }),
    getBypassManager: () => ({
      isActive: (name: string) => name === 'orchestrator' && extras.orchestrator.active,
      activateAgent: async () => {
        extras.orchestrator.active = true;
        extras.orchestrator.setCalls.push(true);
      },
      deactivateAgent: async () => {
        extras.orchestrator.active = false;
        extras.orchestrator.setCalls.push(false);
      },
      getActiveNames: () => (extras.orchestrator.active ? ['orchestrator'] : []),
    }),
    // ── companion 域：mgr + routerSwitcher（与 loop 共享 extras.companion 状态）──
    getCompanionMgr: () => ({
      setCharacter: (name: string) => {
        extras.companion.setCharacterCalls.push(name);
      },
      getOrCreate: () => `/tmp/companion/${extras.companion.characterName || 'default'}`,
      listCharacters: () => extras.companion.characters,
    }),
    getRouterSwitcher: () => ({
      switchRouter: (name: string) => {
        extras.companion.switchCalls.push(name);
        extras.companion.globalName = name;
        // 返回 CompanionRouter 单例（activeCompanionName 可变，映射到共享状态）
        return {
          get activeCompanionName() {
            return extras.companion.characterName;
          },
          set activeCompanionName(v: string) {
            extras.companion.characterName = v;
          },
          // companion 域「换角色」分支直接调用返回对象的 onActivate（绕过 syncRouter）
          onActivate: async (l: unknown) => {
            extras.companion.activateCalls += 1;
            await (l as { switchSession(d: string): Promise<void> }).switchSession(
              `/tmp/companion/${extras.companion.characterName}`,
            );
          },
          onDeactivate: async () => {
            extras.companion.deactivateCalls += 1;
          },
        };
      },
      getActiveRouterName: () => extras.companion.globalName,
      clearPromptCache: () => {
        extras.companion.clearCacheCalls += 1;
      },
    }),
  };
}

// ── 内存 http server + WS 端点（模拟 http-webhook upgrade 路由）──

interface TestEnv {
  httpServer: http.Server;
  port: number;
  sessions: UiWsSession[];
  state: LoopState;
  extras: BackendExtras;
}

async function makeServer(
  options: { paths?: string[]; factory?: AgentFactory } = {},
): Promise<TestEnv> {
  const { paths = CONTRACT_PATHS, factory } = options;
  const state: LoopState = { outputHandler: null, interrupted: 0, runCalls: [], switchCalls: [], pendingTaskName: null, schedulerAdds: [] };
  const extras: BackendExtras = {
    kb: { enabled: true, zone4Enabled: true, setCalls: [] },
    proc: { kills: [], listCalls: 0 },
    statsCalls: [],
    orchestrator: { active: false, setCalls: [] },
    companion: {
      characters: ['alice', '小蝶'],
      switchCalls: [],
      syncCalls: 0,
      activateCalls: 0,
      deactivateCalls: 0,
      clearCacheCalls: 0,
      setCharacterCalls: [],
      globalName: 'normal',
      activeName: 'normal',
      characterName: '',
    },
  };
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0];
    if (!paths.includes(url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const sessions: UiWsSession[] = [];
  wss.on('connection', (ws) => {
    const sessionId = `tui_${Date.now().toString(36)}`;
    const session = new UiWsSession(ws, sessionId, makeBackend(extras));
    sessions.push(session);
    session.initialize(factory ?? makeAgentFactory(state, extras.companion)).catch(() => {});
    ws.on('close', () => {
      session.close().catch(() => {});
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as { port: number };
      resolve({ httpServer, port: addr.port, sessions, state, extras });
    });
  });
}

const openClients: (() => void)[] = [];
afterEach(() => {
  for (const close of openClients.splice(0)) close();
});

/** 建立真实 WS 客户端，记录收到的协议消息 */
function connect(port: number, path = '/tui'): Promise<{
  ws: WebSocket;
  send: (obj: unknown) => void;
  messages: unknown[];
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const messages: unknown[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    ws.on('open', () => {
      openClients.push(() => ws.close());
      resolve({ ws, send: (obj) => ws.send(JSON.stringify(obj)), messages });
    });
    ws.on('error', (err) => reject(err));
  });
}

/** 轮询等待某个协议消息出现 */
async function waitFor(
  cond: () => boolean,
  timeout = 3000,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const byKind = (m: unknown, kind: string) => (m as { kind?: string }).kind === kind;
const byEvent = (type: string) => (m: unknown) =>
  byKind(m, 'event') && (m as { type?: string }).type === type;
const byResponse = (id: string) => (m: unknown) =>
  byKind(m, 'response') && (m as { id?: string }).id === id;

// ════════════════════════════════════════════════════════════
// 契约用例
// ════════════════════════════════════════════════════════════

describe('TUI 远程 / 桌面端 WS 契约（TuiWsSession → UiWsSession 迁移验收）', () => {
  it('连接初始化：initialize 完成后客户端收到 ui.connected 事件（旧 connected 等价物）', async () => {
    const { httpServer, port } = await makeServer();
    const client = await connect(port, '/tui');

    await waitFor(
      () => client.messages.some(byEvent('ui.connected')),
      3000,
      'ui.connected event',
    );
    const evt = client.messages.find(byEvent('ui.connected')) as {
      payload?: { sessionId?: string };
    };
    expect(evt.payload?.sessionId).toBeTruthy();
    httpServer.close();
  });

  it('chat：message.chat 触发 loop.run，输出以 message.* 事件回流（旧 chat → text/status/turn_info）', async () => {
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({ kind: 'request', id: 'c1', method: 'message.chat', params: { content: 'hi' } });

    // loop.run 被调用
    await waitFor(() => state.runCalls.includes('hi'), 3000, 'loop.run called');
    // 事件回流：thinking → text → status（fake loop 输出）
    await waitFor(() => client.messages.some(byEvent('message.thinking')), 3000, 'thinking');
    await waitFor(
      () =>
        client.messages.some(
          (m) =>
            byEvent('message.text')(m) &&
            ((m as { payload?: { content?: string } }).payload?.content === '回复: hi'),
        ),
      3000,
      'text',
    );
    await waitFor(
      () =>
        client.messages.some(
          (m) =>
            byEvent('message.status')(m) &&
            ((m as { payload?: { message?: string } }).payload?.message === '完成'),
        ),
      3000,
      'status',
    );
    // 回合结束：turn_info + state.update
    await waitFor(() => client.messages.some(byEvent('message.turn_info')), 3000, 'turn_info');
    await waitFor(() => client.messages.some(byEvent('state.update')), 3000, 'state.update');
    // 请求响应 ok
    await waitFor(() => client.messages.some(byResponse('c1')), 3000, 'response');
    const resp = client.messages.find(byResponse('c1')) as { ok?: boolean };
    expect(resp.ok).toBe(true);
    httpServer.close();
  });

  it('chat 输出回流：tool_use / tool_result 事件字段与旧协议对齐', async () => {
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');
    await waitFor(() => state.outputHandler !== null, 3000, 'outputHandler wired');

    // 模拟后端工具执行输出（等价旧协议 tool_use / tool_result）
    const h = state.outputHandler!;
    h.onToolUse('read', 'a.md', 'tool-1');
    h.onToolResult('file content', false, 'tool-1');

    await waitFor(() => client.messages.some(byEvent('message.tool_use')), 3000, 'tool_use');
    const tu = client.messages.find(byEvent('message.tool_use')) as {
      payload?: { name?: string; inputSummary?: string; id?: string };
    };
    expect(tu.payload).toMatchObject({ name: 'read', inputSummary: 'a.md', id: 'tool-1' });

    await waitFor(() => client.messages.some(byEvent('message.tool_result')), 3000, 'tool_result');
    const tr = client.messages.find(byEvent('message.tool_result')) as {
      payload?: { content?: string; isError?: boolean; id?: string };
    };
    expect(tr.payload).toMatchObject({ content: 'file content', isError: false, id: 'tool-1' });
    httpServer.close();
  });

  it('stop：message.stop 触发 loop.interrupt 并广播 message.interrupt（旧 stop → requestStop 升级为有效中断）', async () => {
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({ kind: 'request', id: 's1', method: 'message.stop' });

    await waitFor(() => state.interrupted === 1, 3000, 'interrupt called');
    await waitFor(() => client.messages.some(byEvent('message.interrupt')), 3000, 'interrupt event');
    await waitFor(() => client.messages.some(byResponse('s1')), 3000, 'response');
    const resp = client.messages.find(byResponse('s1')) as { ok?: boolean };
    expect(resp.ok).toBe(true);
    httpServer.close();
  });

  it('permission：onPermissionRequest → permission.request 事件 → permission.resolve 闭环', async () => {
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');
    await waitFor(() => state.outputHandler !== null, 3000, 'outputHandler wired');

    // 后端要执行危险工具 → 触发权限请求
    const promise = state.outputHandler!.onPermissionRequest('write', { file: '/tmp/a' });

    // 客户端收到 permission.request（带 id）
    await waitFor(() => client.messages.some(byEvent('permission.request')), 3000, 'perm request');
    const req = client.messages.find(byEvent('permission.request')) as {
      payload?: { id?: string; toolName?: string; input?: Record<string, unknown> };
    };
    expect(req.payload).toMatchObject({ toolName: 'write', input: { file: '/tmp/a' } });
    const reqId = req.payload!.id!;

    // 客户端应答
    client.send({
      kind: 'request',
      id: 'p1',
      method: 'permission.resolve',
      params: { id: reqId, result: 'yes' },
    });

    // 后端 promise 以 'yes' 解析；应答响应 ok
    expect(await promise).toBe('yes');
    await waitFor(() => client.messages.some(byResponse('p1')), 3000, 'response');
    const resp = client.messages.find(byResponse('p1')) as { ok?: boolean };
    expect(resp.ok).toBe(true);
    httpServer.close();
  });

  it('chat 异常：loop.run 抛错 → message.error 事件 + 响应 ok:false（旧 error 消息）', async () => {
    const state2: LoopState = { outputHandler: null, interrupted: 0, runCalls: [], switchCalls: [], pendingTaskName: null, schedulerAdds: [] };
    const failFactory: AgentFactory = {
      createAgent: async (options) => {
        state2.outputHandler = options.outputHandler as unknown as ProtocolOutputHandler;
        return {
          loop: {
            getTurnInfo: (tc: number, tu: number) => ({
              turnCount: tc, maxTurns: 20, tokensUsed: tu, maxContextTokens: 200000,
              sessionId: 'sess_fail', compressCount: 0,
            }),
            getProviderRoutingInfo: () => null,
            getActiveProvider: () => ({ getProviderType: () => 'test', getModel: () => 'm1' }),
            async run(): Promise<void> {
              state2.runCalls.push('x');
              throw new Error('boom');
            },
          },
          sessionDir: '/tmp/sess_fail',
          sessionManager: {} as never,
          toolRegistry: {} as never,
          skillRegistry: {} as never,
        } as never;
      },
    };
    const { httpServer, port } = await makeServer({ factory: failFactory });
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({ kind: 'request', id: 'e1', method: 'message.chat', params: { content: 'x' } });

    // message.error 事件（含错误信息）
    await waitFor(() => client.messages.some(byEvent('message.error')), 3000, 'error event');
    const errEvt = client.messages.find(byEvent('message.error')) as {
      payload?: { message?: string };
    };
    expect(errEvt.payload?.message).toBe('boom');
    // 响应 ok:false
    await waitFor(() => client.messages.some(byResponse('e1')), 3000, 'error response');
    const resp = client.messages.find(byResponse('e1')) as {
      ok?: boolean;
      error?: { message?: string };
    };
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toBe('boom');
    httpServer.close();
  });

  it('/desktop 端点同样走统一协议（ui.connected + message.chat 可用）', async () => {
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/desktop');

    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');
    client.send({ kind: 'request', id: 'd1', method: 'message.chat', params: { content: 'hello' } });
    await waitFor(() => state.runCalls.includes('hello'), 3000, 'loop.run called');
    await waitFor(() => client.messages.some(byEvent('message.text')), 3000, 'text');
    await waitFor(() => client.messages.some(byResponse('d1')), 3000, 'response');
    httpServer.close();
  });

  // ════════════════════════════════════════════════════════════
  // 协议层补齐轮（薄 UI + 厚协议）：session.switch / state.stats /
  // model.sources / kb / process 契约
  // ════════════════════════════════════════════════════════════

  it('session.switch：切换 loop 当前会话目录（对应 TUI /session <id>/load）', async () => {
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({ kind: 'request', id: 'sw1', method: 'session.switch', params: { sessionId: 's1' } });

    // loop.switchSession 收到会话目录（sessionStore.getSessionDir('s1') = '/tmp/s1'）
    await waitFor(() => state.switchCalls.includes('/tmp/s1'), 3000, 'switchSession called');
    await waitFor(() => client.messages.some(byResponse('sw1')), 3000, 'response');
    const resp = client.messages.find(byResponse('sw1')) as { ok?: boolean; result?: { sessionId?: string } };
    expect(resp.ok).toBe(true);
    expect(resp.result?.sessionId).toBe('s1');
    httpServer.close();
  });

  it('session.switch：不存在的会话 → 错误响应 ok:false', async () => {
    const { httpServer, port } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({ kind: 'request', id: 'sw2', method: 'session.switch', params: { sessionId: 'nope' } });
    await waitFor(() => client.messages.some(byResponse('sw2')), 3000, 'response');
    const resp = client.messages.find(byResponse('sw2')) as { ok?: boolean };
    expect(resp.ok).toBe(false);
    httpServer.close();
  });

  it('state.stats：返回会话统计（对应 TUI statsManager 直读）', async () => {
    const { httpServer, port, extras } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({ kind: 'request', id: 'st1', method: 'state.stats', params: { sessionId: 's1' } });
    await waitFor(() => client.messages.some(byResponse('st1')), 3000, 'response');
    const resp = client.messages.find(byResponse('st1')) as {
      ok?: boolean;
      result?: { sessionId?: string; stats?: { turn_count?: number } };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result).toMatchObject({ sessionId: 's1', stats: { turn_count: 3 } });
    expect(extras.statsCalls).toContain('s1');
    httpServer.close();
  });

  it('model.sources：返回各角色模型来源（对应 TUI /models）', async () => {
    const { httpServer, port } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({ kind: 'request', id: 'ms1', method: 'model.sources' });
    await waitFor(() => client.messages.some(byResponse('ms1')), 3000, 'response');
    const resp = client.messages.find(byResponse('ms1')) as {
      ok?: boolean;
      result?: { sources?: Record<string, string> | null };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ sources: { assessment: 'main', planning: 'local' } });
    httpServer.close();
  });

  it('kb 域：kb.get 查询状态，kb.setZone4 / kb.setEnabled 写开关（对应 TUI /zone4、/kb）', async () => {
    const { httpServer, port, extras } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    // kb.get
    client.send({ kind: 'request', id: 'kb1', method: 'kb.get' });
    await waitFor(() => client.messages.some(byResponse('kb1')), 3000, 'kb.get response');
    const getResp = client.messages.find(byResponse('kb1')) as {
      ok?: boolean;
      result?: { kb?: { enabled?: boolean; zone4Enabled?: boolean } };
    };
    expect(getResp.ok).toBe(true);
    expect(getResp.result?.kb).toEqual({ enabled: true, zone4Enabled: true });

    // kb.setZone4 false
    client.send({ kind: 'request', id: 'kb2', method: 'kb.setZone4', params: { enabled: false } });
    await waitFor(() => client.messages.some(byResponse('kb2')), 3000, 'kb.setZone4 response');
    const z4Resp = client.messages.find(byResponse('kb2')) as {
      ok?: boolean;
      result?: { kb?: { zone4Enabled?: boolean } };
    };
    expect(z4Resp.ok).toBe(true);
    expect(z4Resp.result?.kb?.zone4Enabled).toBe(false);
    expect(extras.kb.zone4Enabled).toBe(false);

    // kb.setEnabled false
    client.send({ kind: 'request', id: 'kb3', method: 'kb.setEnabled', params: { enabled: false } });
    await waitFor(() => client.messages.some(byResponse('kb3')), 3000, 'kb.setEnabled response');
    const enResp = client.messages.find(byResponse('kb3')) as { ok?: boolean };
    expect(enResp.ok).toBe(true);
    expect(extras.kb.enabled).toBe(false);
    expect(extras.kb.setCalls).toEqual([{ zone4: false }, { enabled: false }]);
    httpServer.close();
  });

  it('process 域：process.list 返回后台进程，process.kill 终止（对应 TUI /bg）', async () => {
    const { httpServer, port, extras } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    // process.list
    client.send({ kind: 'request', id: 'pr1', method: 'process.list' });
    await waitFor(() => client.messages.some(byResponse('pr1')), 3000, 'process.list response');
    const listResp = client.messages.find(byResponse('pr1')) as {
      ok?: boolean;
      result?: { processes?: Array<{ handle?: string; name?: string; status?: string }> };
    };
    expect(listResp.ok).toBe(true);
    expect(listResp.result?.processes).toEqual([
      expect.objectContaining({ handle: 'h1', name: 'dev-server', status: 'running' }),
    ]);
    expect(extras.proc.listCalls).toBe(1);

    // process.kill
    client.send({ kind: 'request', id: 'pr2', method: 'process.kill', params: { handle: 'h1' } });
    await waitFor(() => client.messages.some(byResponse('pr2')), 3000, 'process.kill response');
    const killResp = client.messages.find(byResponse('pr2')) as { ok?: boolean; result?: { ok?: boolean } };
    expect(killResp.ok).toBe(true);
    expect(killResp.result?.ok).toBe(true);
    expect(extras.proc.kills).toEqual(['h1']);
    httpServer.close();
  });

  it('schedule.addDaily：每日定点任务（对应 TUI /schedule-add → loop.addScheduledTask）', async () => {
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({
      kind: 'request',
      id: 'sa1',
      method: 'schedule.addDaily',
      params: { name: 'morning', time: '08:00' },
    });

    await waitFor(() => state.schedulerAdds.length === 1, 3000, 'addTask called');
    expect(state.schedulerAdds[0]).toEqual({ name: 'morning', time: '08:00' });
    await waitFor(() => client.messages.some(byResponse('sa1')), 3000, 'response');
    const resp = client.messages.find(byResponse('sa1')) as { ok?: boolean };
    expect(resp.ok).toBe(true);
    httpServer.close();
  });

  it('schedule.runtime：返回当前执行中的调度任务名（对应 TUI 状态栏 pendingTaskName）', async () => {
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    // 无任务
    client.send({ kind: 'request', id: 'rt1', method: 'schedule.runtime' });
    await waitFor(() => client.messages.some(byResponse('rt1')), 3000, 'runtime response');
    let resp = client.messages.find(byResponse('rt1')) as {
      ok?: boolean;
      result?: { pendingTaskName?: string | null };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result?.pendingTaskName).toBeNull();

    // 模拟调度任务执行中（loop.pendingTaskName 变化）
    state.pendingTaskName = 'morning';
    client.send({ kind: 'request', id: 'rt2', method: 'schedule.runtime' });
    await waitFor(() => client.messages.some(byResponse('rt2')), 3000, 'runtime2 response');
    resp = client.messages.find(byResponse('rt2')) as {
      ok?: boolean;
      result?: { pendingTaskName?: string | null };
    };
    expect(resp.result?.pendingTaskName).toBe('morning');
    httpServer.close();
  });


  it('orchestrator 域：orchestrator.get 查询，orchestrator.setEnabled 激活/停用（对应 TUI /orchestrator on|off）', async () => {
    const { httpServer, port, extras } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    // orchestrator.get（初始 inactive）
    client.send({ kind: 'request', id: 'og1', method: 'orchestrator.get' });
    await waitFor(() => client.messages.some(byResponse('og1')), 3000, 'orchestrator.get response');
    let resp = client.messages.find(byResponse('og1')) as {
      ok?: boolean;
      result?: { orchestrator?: { active?: boolean; activeAgents?: string[] } };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result?.orchestrator).toEqual({ active: false, activeAgents: [] });

    // orchestrator.setEnabled true
    client.send({ kind: 'request', id: 'oe1', method: 'orchestrator.setEnabled', params: { enabled: true } });
    await waitFor(() => client.messages.some(byResponse('oe1')), 3000, 'orchestrator.setEnabled response');
    resp = client.messages.find(byResponse('oe1')) as {
      ok?: boolean;
      result?: { orchestrator?: { active?: boolean; activeAgents?: string[] } };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result?.orchestrator?.active).toBe(true);
    expect(resp.result?.orchestrator?.activeAgents).toEqual(['orchestrator']);
    expect(extras.orchestrator.setCalls).toEqual([true]);

    // orchestrator.setEnabled false
    client.send({ kind: 'request', id: 'oe2', method: 'orchestrator.setEnabled', params: { enabled: false } });
    await waitFor(() => client.messages.some(byResponse('oe2')), 3000, 'orchestrator.setEnabled response');
    resp = client.messages.find(byResponse('oe2')) as {
      ok?: boolean;
      result?: { orchestrator?: { active?: boolean } };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result?.orchestrator?.active).toBe(false);
    expect(extras.orchestrator.setCalls).toEqual([true, false]);
    httpServer.close();
  });

  it('companion 域：companion.get 查询（未激活时 active=false + 可用角色列表）', async () => {
    const { httpServer, port } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({ kind: 'request', id: 'cg1', method: 'companion.get' });
    await waitFor(() => client.messages.some(byResponse('cg1')), 3000, 'companion.get response');
    const resp = client.messages.find(byResponse('cg1')) as {
      ok?: boolean;
      result?: { active?: boolean; character?: string; characters?: string[] };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result?.active).toBe(false);
    expect(resp.result?.character).toBe('');
    // 角色列表来自 backend 的 CompanionSessionManager（非文件系统扫描）
    expect(resp.result?.characters).toEqual(['alice', '小蝶']);
    httpServer.close();
  });

  it('companion 域：companion.activate 经真实 syncRouter 闭环进入陪伴模式，get 反映新状态', async () => {
    const { httpServer, port, state, extras } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    client.send({
      kind: 'request', id: 'ca1', method: 'companion.activate', params: { character: 'alice' },
    });
    await waitFor(() => client.messages.some(byResponse('ca1')), 3000, 'companion.activate response');
    const resp = client.messages.find(byResponse('ca1')) as {
      ok?: boolean;
      result?: { active?: boolean; character?: string };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ active: true, character: 'alice' });

    // 切换闭环：switchRouter 设全局名 → syncRouter 触发 onActivate（切 session）→ 清 prompt 缓存
    expect(extras.companion.switchCalls).toEqual(['companion']);
    expect(extras.companion.syncCalls).toBe(1);
    expect(extras.companion.activateCalls).toBe(1);
    expect(extras.companion.clearCacheCalls).toBe(1);
    expect(state.switchCalls).toContain('/tmp/companion/alice');

    // 激活后 get：active=true + 当前角色
    client.send({ kind: 'request', id: 'cg2', method: 'companion.get' });
    await waitFor(() => client.messages.some(byResponse('cg2')), 3000, 'companion.get after activate');
    const getResp = client.messages.find(byResponse('cg2')) as {
      ok?: boolean;
      result?: { active?: boolean; character?: string };
    };
    expect(getResp.ok).toBe(true);
    expect(getResp.result?.active).toBe(true);
    expect(getResp.result?.character).toBe('alice');
    httpServer.close();
  });

  it('companion 域：companion.deactivate 切回 normal，重复调用幂等', async () => {
    const { httpServer, port, extras } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

    // 先激活
    client.send({
      kind: 'request', id: 'ca2', method: 'companion.activate', params: { character: '小蝶' },
    });
    await waitFor(() => client.messages.some(byResponse('ca2')), 3000, 'companion.activate response');

    // 退出：switchRouter('normal') → syncRouter（onDeactivate 停 bypass / 切回 normal session）
    client.send({ kind: 'request', id: 'cd1', method: 'companion.deactivate' });
    await waitFor(() => client.messages.some(byResponse('cd1')), 3000, 'companion.deactivate response');
    const resp = client.messages.find(byResponse('cd1')) as {
      ok?: boolean;
      result?: { active?: boolean };
    };
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ active: false });
    expect(extras.companion.switchCalls).toEqual(['companion', 'normal']);
    expect(extras.companion.deactivateCalls).toBe(1);
    expect(extras.companion.clearCacheCalls).toBe(2);

    // 幂等：未激活时再 deactivate 不触发任何钩子
    client.send({ kind: 'request', id: 'cd2', method: 'companion.deactivate' });
    await waitFor(() => client.messages.some(byResponse('cd2')), 3000, 'idempotent deactivate');
    const resp2 = client.messages.find(byResponse('cd2')) as {
      ok?: boolean;
      result?: { active?: boolean };
    };
    expect(resp2.ok).toBe(true);
    expect(resp2.result).toEqual({ active: false });
    expect(extras.companion.deactivateCalls).toBe(1);
    expect(extras.companion.syncCalls).toBe(2); // 只有激活 + 首次退出两次
    httpServer.close();
  });

  it('companion 事件回流：onEvent(companion.say/voice) 广播到客户端（表达契约统一出口）', async () => {
    // 表达契约：主 agent 的普通文本只是内心独白，台词必须经 companion_say
    // "发声" → companion.say 事件 → 所有前端（WebUI/TUI/Desktop）同一出口。
    // 此用例锁定协议层事件名与载荷契约（sayId 关联文字与语音）。
    const { httpServer, port, state } = await makeServer();
    const client = await connect(port, '/tui');
    await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');
    await waitFor(() => state.outputHandler !== null, 3000, 'outputHandler wired');
    const h = state.outputHandler!;

    h.onEvent(UI_EVENT.COMPANION_SAY, {
      text: '[微笑]（她回来了）你回来啦',
      tone: '开心',
      sayId: 'say_abc',
    });
    h.onEvent(UI_EVENT.COMPANION_VOICE, {
      state: 'ready',
      url: '/api/companion/voice/gv_xxx/file',
      sayId: 'say_abc',
      character: '柔柔',
      cached: false,
    });

    await waitFor(() => client.messages.some(byEvent(UI_EVENT.COMPANION_SAY)), 3000, 'companion.say');
    await waitFor(() => client.messages.some(byEvent(UI_EVENT.COMPANION_VOICE)), 3000, 'companion.voice');

    const say = client.messages.find(byEvent(UI_EVENT.COMPANION_SAY)) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(say.payload).toMatchObject({
      text: expect.stringContaining('你回来啦'),
      tone: '开心',
      sayId: 'say_abc',
    });

    const voice = client.messages.find(byEvent(UI_EVENT.COMPANION_VOICE)) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(voice.payload).toMatchObject({
      state: 'ready',
      sayId: 'say_abc',
      url: '/api/companion/voice/gv_xxx/file',
      character: '柔柔',
      cached: false,
    });
  });
});
