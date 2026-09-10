// ============================================================
// UI 协议层 — 单一装配器（UiProtocolSession）集成测试
// ============================================================
// 验证生产入口 UiProtocolSession（P5-1 双装配点收敛后唯一装配器）：
//  1. 可实例化，暴露 server / outputHandler / pending
//  2. 全部 17 域注册（listDomains 齐全）
//  3. 各域通过 InProc 端到端可用（config/session/model/message/state/command/permission）
//  4. outputHandler 事件桥：后端回调 → 协议事件广播
// ============================================================

import { describe, it, expect } from 'vitest';
import { SessionManager } from '../memory/session.js';
import { InProcAdapter } from './index.js';
// 装配器在 channels 层（依赖 AgentFactory/ChannelOutputHandler），
// 协议层 index.ts 保持纯净不 re-export，测试直接从来源导入。
import { UiProtocolSession } from '../channels/builtin/ui-protocol-session.js';
import type { UiProtocolSessionBackend } from '../channels/builtin/ui-protocol-session.js';
import type { AgentFactory, ChannelOutputHandler } from '../channels/interface.js';
import type { UiMessage, UiResponse, UiEvent, ConfigChangeEvent, ProtocolMeta } from './types.js';
import { UI_DOMAIN, UI_METHOD, UI_EVENT } from './types.js';

// ── mock backend（loop 由 mock agentFactory 注入）──────────────

function makeBackend(overrides: Partial<UiProtocolSessionBackend> = {}): UiProtocolSessionBackend {
  const configState = {
    provider: { active: 'anthropic', routeMode: 'auto' },
    session: { maxTurns: 100, maxContext: 200000, maxMessages: 10000 },
    context: { compressThreshold: 0.75 },
  };
  const watchers = new Set<(event: ConfigChangeEvent) => void>();

  const backend: UiProtocolSessionBackend = {
    configCenter: {
      get: <T = unknown>(p: string): T => {
        let cur: unknown = configState;
        for (const seg of p.split('.')) {
          if (cur === null || typeof cur !== 'object') return undefined as T;
          cur = (cur as Record<string, unknown>)[seg];
        }
        return cur as T;
      },
      getAll: () => JSON.parse(JSON.stringify(configState)),
      set: () => {},
      merge: () => {},
      reset: () => {},
      watch: (_p: string, cb: (event: ConfigChangeEvent) => void) => {
        watchers.add(cb);
        return () => {
          watchers.delete(cb);
        };
      },
    } as never,
    sessionStore: new SessionManager(process.cwd(), '__unused__') as never,
    registry: {
      listChannels: () => [{ name: 'main', provider: 'anthropic', model: 'claude-sonnet-5' }],
      upsertChannel: () => {},
      removeChannel: () => {},
      setChannelModel: () => {},
      resetChannelModel: () => {},
      getChannelInfo: () => null,
      getMainProvider: () => ({
        getProviderType: () => 'anthropic',
        getModel: () => 'claude-sonnet-5',
        getCapabilities: () => ({ isLocal: false, maxContextTokens: 200000 }),
      }),
      getProviderType: () => 'anthropic',
      getModel: () => 'claude-sonnet-5',
      setThinking: () => {},
    } as never,
    manager: { switchProvider: () => {} } as never,
    commandRegistry: {
      getByCategory: () => new Map([['system', [{ name: 'clear', description: '清屏', category: 'system', executeLocal: true }]]]),
      find: () => undefined,
    } as never,
    listProvidersMeta: () => [
      { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5' },
      { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5.5' },
    ],
    ...overrides,
  };
  return backend;
}

/** mock loop：记录 run 内容；若注入 outputHandler 则模拟后端输出 */
function makeLoop() {
  const state: { outputHandler: ChannelOutputHandler | null; ran: string } = {
    outputHandler: null,
    ran: '',
  };
  const loop = {
    getTurnInfo: (tc: number, tu: number) => ({
      turnCount: tc,
      maxTurns: 20,
      tokensUsed: tu,
      maxContextTokens: 200000,
      sessionId: 'sess_test',
      compressCount: 0,
    }),
    getProviderRoutingInfo: () => ({ providerLabel: 'Anthropic', isLocal: false, mode: 'auto' }),
    getActiveProvider: () => ({ getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' }),
    async run(content: string): Promise<void> {
      state.ran = content;
    },
    interrupt: () => {},
    turnNumber: 0,
    contextTokensUsed: 0,
  };
  return { loop, state };
}

/** mock agentFactory：把注入的 outputHandler 捕获给 loop 状态，返回 mock loop */
function makeAgentFactory(
  loop: ReturnType<typeof makeLoop>['loop'],
  state: ReturnType<typeof makeLoop>['state'],
): AgentFactory {
  return {
    createAgent: async ({ outputHandler }) => {
      state.outputHandler = outputHandler;
      return { loop: loop as never };
    },
  };
}

/** 建立 client + UiProtocolSession（已 initialize + attach）的完整链路 */
async function setup(backend?: UiProtocolSessionBackend) {
  const { loop, state } = makeLoop();
  const agentFactory = makeAgentFactory(loop, state);

  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);

  const session = new UiProtocolSession(serverAdp, 'sess_test', backend ?? makeBackend());
  await session.initialize(agentFactory);

  const responses: UiResponse[] = [];
  const events: UiEvent[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
    else if (m.kind === 'event') events.push(m);
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return { session, client, responses, events, flush, ran: () => state.ran, outputHandler: session.outputHandler };
}

/** 发送请求并轮询等待响应 */
async function request(
  client: InProcAdapter,
  responses: UiResponse[],
  id: string,
  method: string,
  params?: unknown,
): Promise<UiResponse> {
  client.send({ kind: 'request', id, method, params } as UiMessage);
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const found = responses.find((r) => r.id === id);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout: ${method}`);
}

describe('UiProtocolSession 单一装配器', () => {
  it('可实例化，暴露 server/outputHandler/pending', () => {
    const session = new UiProtocolSession(new InProcAdapter('server'), 's1', makeBackend());
    expect(session.server).toBeTruthy();
    expect(session.outputHandler).toBeTruthy();
    expect(session.pending).toBeTruthy();
  });

  it('全部 20 域注册到协议服务器（19 业务域 + 内建 meta）', async () => {
    const { session } = await setup();
    const domains = session.server.listDomains().sort();
    expect(domains).toEqual(
      ['arch', 'bundle', 'command', 'companion', 'config', 'context', 'kb', 'mcp', 'message', 'meta', 'model', 'orchestrator', 'permission', 'plugin', 'process', 'schedule', 'session', 'state', 'supervisor', 'tool'].sort(),
    );
  });

  it('端到端：config.get 可用', async () => {
    const { client, responses } = await setup();
    const resp = await request(client, responses, 'r1', 'config.get', { path: 'session.maxTurns' });
    expect(resp).toMatchObject({ id: 'r1', ok: true });
    expect(resp.result).toEqual({ path: 'session.maxTurns', value: 100 });
  });

  it('端到端：state.get 可用', async () => {
    const { client, responses } = await setup();
    const resp = await request(client, responses, 'r1', 'state.get');
    expect(resp).toMatchObject({ id: 'r1', ok: true });
    const snap = resp.result as any;
    expect(snap).toMatchObject({ model: 'claude-sonnet-5', provider: 'anthropic' });
  });

  it('端到端：model.listProviders 可用', async () => {
    const { client, responses } = await setup();
    const resp = await request(client, responses, 'r1', 'model.listProviders');
    expect(resp).toMatchObject({ id: 'r1', ok: true });
    expect((resp.result as any).providers).toHaveLength(2);
  });

  it('端到端：command.list 可用', async () => {
    const { client, responses } = await setup();
    const resp = await request(client, responses, 'r1', 'command.list');
    expect(resp).toMatchObject({ id: 'r1', ok: true });
    expect((resp.result as any).categories.length).toBeGreaterThanOrEqual(1);
  });

  it('端到端：message.chat 可用（loop.run 被调用）', async () => {
    const { client, responses, ran } = await setup();
    const resp = await request(client, responses, 'r1', 'message.chat', { content: 'hi' });
    expect(resp).toMatchObject({ id: 'r1', ok: true });
    expect(ran()).toBe('hi');
  });

  it('outputHandler 事件桥：后端 onText 回调 → message.text 事件到达客户端', async () => {
    const { outputHandler, client, events } = await setup();
    outputHandler.onText('hello from backend');
    await new Promise((r) => setTimeout(r, 20));
    const evt = events.find((e) => e.type === 'message.text');
    expect(evt).toBeTruthy();
    expect(evt!.payload).toEqual({ content: 'hello from backend' });
  });

  it('未知方法 → UNKNOWN_DOMAIN', async () => {
    const { client, responses } = await setup();
    const resp = await request(client, responses, 'r1', 'nope.thing');
    expect(resp).toMatchObject({ id: 'r1', ok: false });
    expect(resp.error?.code).toBe('UNKNOWN_DOMAIN');
  });
});

// ============================================================
// P5-4 常量同源守卫
// ============================================================
// types.ts 的 UI_DOMAIN / UI_METHOD / UI_EVENT 与运行时注册表是两份
// 事实源，手工同步必然漂移（本次收敛前：5 个域、44 个方法未登记，
// 1 个方法已不存在）。这里用真实装配（UiProtocolSession 全 18 域）
// 做双向断言，任一侧新增或遗漏都会让测试变红。
//
// 为何不干脆"从运行时生成常量"：那需要 server 实例，编译期拿不到，
// 常量会退化成 string —— 丢失字面量类型、IDE 补全与 switch 穷尽检查
// （tui.ts 的事件 switch 依赖字面量）。保留常量 + 测试守卫是代价更低
// 的组合：编译期类型安全 + CI 期漂移拦截。
// ============================================================

describe('P5-4 常量同源守卫', () => {
  /** 取运行时真实能力清单（meta.get，排除自身后补回 meta.get） */
  async function runtimeMeta(): Promise<ProtocolMeta> {
    const { client, responses } = await setup();
    const resp = await request(client, responses, 'meta1', 'meta.get');
    expect(resp.ok).toBe(true);
    return resp.result as ProtocolMeta;
  }

  it('UI_DOMAIN 与已注册域完全一致（无缺域、无幽灵域）', async () => {
    const { session } = await setup();
    const declared = [...Object.values(UI_DOMAIN)].sort();
    const registered = session.server.listDomains().sort();
    expect(declared).toEqual(registered);
  });

  it('UI_METHOD 与运行时方法清单双向一致（无幽灵方法、无漏登记方法）', async () => {
    const meta = await runtimeMeta();
    const runtime = new Set<string>();
    for (const [domain, actions] of Object.entries(meta.methods)) {
      for (const action of actions) runtime.add(`${domain}.${action}`);
    }
    // meta 域按设计不列入自身能力清单（P5-3 避免自引用），守卫时补回
    runtime.add(UI_METHOD.META_GET);

    const declared = Object.values(UI_METHOD) as string[];
    // 常量声明但后端不存在：typo / 方法已删除而常量残留
    const ghost = declared.filter((m) => !runtime.has(m)).sort();
    // 后端实现但常量未声明：新增域/方法忘记登记常量
    const undeclared = [...runtime].filter((m) => !declared.includes(m)).sort();

    expect({ ghost, undeclared }).toEqual({ ghost: [], undeclared: [] });
  });

  it('UI_EVENT 的事件前缀都落在已知域或传输层保留命名空间', () => {
    // 'ui' 是传输层保留前缀（ui.connected / ui.error），不对应任何域
    const allowed = new Set<string>([...Object.values(UI_DOMAIN), 'ui']);
    const orphan = Object.values(UI_EVENT)
      .filter((e) => !allowed.has(e.slice(0, e.indexOf('.'))))
      .sort();
    expect(orphan).toEqual([]);
  });

  it('生命周期方法不泄漏为协议方法（config.dispose 回归）', async () => {
    const meta = await runtimeMeta();
    // 能力清单不得把 dispose 报给客户端
    expect(meta.methods.config).not.toContain('dispose');

    // 且不得被远程调用：dispose 会取消全局 config 订阅，
    // 一旦可 RPC，任意客户端都能让所有 UI 的 config.change 静默失效。
    const { client, responses } = await setup();
    const probe = await request(client, responses, 'probe1', 'config.dispose');
    expect(probe.ok).toBe(false);
    expect(probe.error?.code).toBe('UNKNOWN_METHOD');
  });
});
