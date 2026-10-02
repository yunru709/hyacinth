/**
 * loop-integration.test.ts —— AgentLoop 级集成测试（P0 回归锁定）。
 *
 * 独立审查报告指出的核心 bug：runTurn 每轮调 `pipeline.run()` 7 次，
 * 而 `run()` 每次全槽遍历 → llm 阶段每轮重复执行 7 次（createStream 7 次），
 * 且首次调用发生在 activeProvider 路由赋值前 → context 阶段崩。
 * 修复：Pipeline 新增 `runSlot(slotId)`，runTurn 按阶段逐槽调用。
 *
 * 本测试构造**真实 AgentLoop + 真实 6 槽 pipeline**（createKernel 内置阶段
 * 模块），仅 mock 外部服务。核心断言：一轮 turn 内 `provider.createStream`
 * **恰好 1 次**、首轮不崩、finalize 正常结束（stop=true）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './loop.js';
import type { AgentLoopServices } from './loop.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { Provider } from '../provider/interface.js';

const tmpDirs: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-int-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** 模拟 provider：createStream 返回一段文本流，spy 计数 */
function makeProvider() {
  const createStream = vi.fn().mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', content: '你好' };
      yield { type: 'stop', reason: 'end_turn' };
    },
  }));
  const provider = {
    getProviderType: () => 'deepseek',
    getModel: () => 'deepseek-chat',
    getCapabilities: () => ({ vision: false }),
    setThinking: vi.fn(),
    createStream,
  } as unknown as Provider;
  return { provider, createStream };
}

/** 构造 AgentLoopServices：各阶段模块 require/get 的服务全量提供（参考 stages/context.test.ts mock 面） */
function makeServices(provider: Provider): AgentLoopServices {
  const conversationStore = {
    readAll: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const eventStore = { append: vi.fn().mockResolvedValue(undefined) };
  const statsManager = {
    get: vi.fn().mockResolvedValue({ input_tokens: 0, output_tokens: 0, cache_turns: [] }),
    update: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn().mockResolvedValue(undefined),
  };
  const summaryStore = {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const toolRegistry = {
    register: vi.fn(),
    getToolDefinitions: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
  };
  const contextComposer = {
    compose: vi.fn().mockResolvedValue({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      zoneBreakdown: { total: 100 },
    }),
    activeConditions: new Set<string>(),
  };
  return {
    provider,
    contextComposer,
    compressor: { compress: vi.fn().mockResolvedValue(null) } as never,
    orchestrator: {} as never,
    toolExecutor: {} as never,
    toolRegistry: toolRegistry as never,
    conversationStore: conversationStore as never,
    eventStore: eventStore as never,
    statsManager: statsManager as never,
    summaryStore: summaryStore as never,
    flowRegistry: { getActive: () => null } as never,
  } as unknown as AgentLoopServices;
}

describe('AgentLoop 集成：runTurn ↔ pipeline（P0 回归）', () => {
  it('一轮 turn：provider.createStream 恰好调用 1 次（修复前为 7 次）', async () => {
    const { provider, createStream } = makeProvider();
    const loop = new AgentLoop(makeServices(provider), { sessionDir: tmpdir() });

    const result = await (loop as unknown as { runTurn(): Promise<{ stop: boolean; stopReason?: string }> }).runTurn();

    expect(createStream).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe(true);
  });

  it('首轮不崩溃：activeProvider 在 input 阶段后、context 阶段前已路由赋值', async () => {
    const { provider } = makeProvider();
    const loop = new AgentLoop(makeServices(provider), { sessionDir: tmpdir() });

    await expect(
      (loop as unknown as { runTurn(): Promise<unknown> }).runTurn(),
    ).resolves.toBeDefined();
  });

  it('阶段编排：llm 唯一一次请求用的 messages 来自 context 阶段产出（compose 被消费）', async () => {
    const { provider, createStream } = makeProvider();
    const loop = new AgentLoop(makeServices(provider), { sessionDir: tmpdir() });

    await (loop as unknown as { runTurn(): Promise<unknown> }).runTurn();

    // createStream 收到的第一个参数是 messages（context compose 的产物）
    const messages = createStream.mock.calls[0]?.[0] as unknown[];
    expect(Array.isArray(messages)).toBe(true);
    expect(messages?.length).toBeGreaterThan(0);
  });

  it('连续多轮：每轮恰好 1 次 createStream（无累积翻倍）', async () => {
    const { provider, createStream } = makeProvider();
    const loop = new AgentLoop(makeServices(provider), { sessionDir: tmpdir() });
    const rt = () => (loop as unknown as { runTurn(): Promise<{ stop: boolean }> }).runTurn();

    await rt();
    await rt();
    await rt();

    expect(createStream).toHaveBeenCalledTimes(3);
  });
});

// ── maxContextTokens 兜底链回归（490ef42 修复锁定）──────────────────

describe('AgentLoop maxContextTokens 兜底链（490ef42 回归）', () => {
  /** 构造最小 configCenter mock（get 按路径返回；watch 空实现返回退订函数） */
  function makeConfigCenter(pathValues: Record<string, unknown>): RuntimeConfigCenter {
    return {
      get: vi.fn((path: string) => pathValues[path]),
      watch: vi.fn(() => () => {}),
    } as unknown as RuntimeConfigCenter;
  }

  function makeLoop(configCenter: RuntimeConfigCenter | undefined, opts: Record<string, unknown> = {}): number {
    const services = makeServices(makeProvider().provider);
    if (configCenter) services.configCenter = configCenter;
    const loop = new AgentLoop(services, { sessionDir: tmpdir(), ...opts } as never);
    return (loop as unknown as { maxContextTokens: number }).maxContextTokens;
  }

  it('config 配了 session.maxContext → 用 config（配置为权威）', () => {
    const cfg = makeConfigCenter({ 'session.maxContext': 300000 });
    // opts 也传了更小值 → config 仍优先
    expect(makeLoop(cfg, { maxContextTokens: 8000 })).toBe(300000);
  });

  it('config 未配 + opts 显式传 maxContextTokens → 用 opts（修复点 1）', () => {
    const cfg = makeConfigCenter({}); // 未配 session.maxContext
    expect(makeLoop(cfg, { maxContextTokens: 123456 })).toBe(123456);
  });

  it('config 与 opts 都缺 → DEFAULT_MAX_CONTEXT_TOKENS（修复点 2，原为 undefined）', () => {
    expect(makeLoop(undefined, {})).toBe(200000); // DEFAULT_MAX_CONTEXT_TOKENS
  });

  it('config 存在但完全未配 → 也回退 opts/DEFAULT（原实现返回 undefined 的路径）', () => {
    const cfg = makeConfigCenter({});
    expect(makeLoop(cfg, {})).toBe(200000);
    expect(makeLoop(cfg, { maxContextTokens: 777 })).toBe(777);
  });
});

// ── 输出被截断：可见提示（A）+ 自动续写（B）（2026-10-02 新增）────────

describe('AgentLoop 截断处理：length/max_tokens → 提示 + 有限续写', () => {
  /** provider：每一轮都把输出"截断"在 length（模拟顶满单次输出上限）。
   *  ⚠️ 事件类型必须**大写**（'TEXT'/'STOP'）：OutputRouter 按大写分发，小写会被
   *  default 分支静默吞掉 ⇒ stopReason 退化成 end_turn（本测试首版就这么假绿过）。
   *  文本逐轮变化且足够短：避开 text-loop 检测（否则会注入反射消息、可能提前 break）。 */
  function makeTruncatingProvider() {
    let n = 0;
    const createStream = vi.fn().mockImplementation(() => {
      const tag = `半截${++n}`;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'TEXT', content: tag };
          yield { type: 'STOP', reason: 'length' };
        },
      };
    });
    const provider = {
      getProviderType: () => 'deepseek',
      getModel: () => 'deepseek-chat',
      getCapabilities: () => ({ vision: false }),
      setThinking: vi.fn(),
      createStream,
    } as unknown as Provider;
    return { provider, createStream };
  }

  it('截断 ⇒ 注入"从断点继续"并续写；上限 3 次后停住（不无限续）', async () => {
    const { provider, createStream } = makeTruncatingProvider();
    const services = makeServices(provider);
    const onStatus = vi.fn();
    (services as unknown as { outputHandler: unknown }).outputHandler = { onStatus };

    const loop = new AgentLoop(services, { sessionDir: tmpdir() });
    await (loop as unknown as { run(input: string): Promise<void> }).run('写一篇长文');


    // 首轮 + 3 次续写 = 4 次请求；第 4 轮不再注入 ⇒ 恰好停住。
    // 这条断言同时守住"续写上限真的生效"（否则会一路撞到 maxTurns）。
    expect(createStream).toHaveBeenCalledTimes(4);

    const cs = (services as unknown as { conversationStore: { append: ReturnType<typeof vi.fn> } }).conversationStore;
    const injected = cs.append.mock.calls
      .map((c) => JSON.stringify(c[1]))
      .filter((t) => t.includes('cut off by the per-request output limit'));
    expect(injected, '应恰好注入 3 条续写指令').toHaveLength(3);

    // A：用户可见提示（带 reason + 可执行指引）
    const statuses = onStatus.mock.calls.map((c) => String(c[0]));
    expect(statuses.some((s) => s.includes('length') && s.includes('/maxoutput'))).toBe(true);
  });

  it('正常结束（end_turn）不受影响：不注入、不提示', async () => {
    // 用大写事件类型的 provider（见上条注释：小写 stop 会被 router 吞掉，测不出真语义）
    const createStream = vi.fn().mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'TEXT', content: '你好' };
        yield { type: 'STOP', reason: 'end_turn' };
      },
    }));
    const provider = {
      getProviderType: () => 'deepseek',
      getModel: () => 'deepseek-chat',
      getCapabilities: () => ({ vision: false }),
      setThinking: vi.fn(),
      createStream,
    } as unknown as Provider;
    const services = makeServices(provider);
    const onStatus = vi.fn();
    (services as unknown as { outputHandler: unknown }).outputHandler = { onStatus };

    const loop = new AgentLoop(services, { sessionDir: tmpdir() });
    await (loop as unknown as { run(input: string): Promise<void> }).run('你好');

    expect(createStream).toHaveBeenCalledTimes(1);
    const cs = (services as unknown as { conversationStore: { append: ReturnType<typeof vi.fn> } }).conversationStore;
    expect(
      cs.append.mock.calls.map((c) => JSON.stringify(c[1])).some((t) => t.includes('cut off by the per-request output limit')),
      '正常结束不该注入续写指令',
    ).toBe(false);
    expect(onStatus.mock.calls.map((c) => String(c[0])).some((s) => s.includes('/maxoutput'))).toBe(false);
  });
});

// ── 渠道附图：base64 不落盘（2026-09-19 改造锁定）─────────────────────

describe('渠道附图：不落盘 base64（与工具图同构）', () => {
  it('落盘只有纯文本 + 剥离标记；base64 仅存在于本轮请求', async () => {
    const { provider } = makeProvider();
    // 视觉模型 → 才会走渠道图分支
    (provider as unknown as { getCapabilities: () => unknown }).getCapabilities = () => ({ vision: true });
    const services = makeServices(provider);
    const loop = new AgentLoop(services, { sessionDir: tmpdir() });

    const SENTINEL = 'Q0hBTk5FTF9JTUFHRV9TRU5USU5FTA==';
    (loop as unknown as { channelImages: unknown }).channelImages = [
      { data: SENTINEL, media_type: 'image/png' },
    ];

    // ★ 必须走 run()：输入处理段（渠道图分支 + append 用户消息）在 _runInternal 里，
    //   而 harness 默认用的 runTurn() 是 _runInternal 内部调用的方法 ⇒ 会整段绕过。
    await (loop as unknown as { run(input: string): Promise<void> }).run('look at this');

    const cs = (services as unknown as { conversationStore: { append: ReturnType<typeof vi.fn> } }).conversationStore;
    // 防空过：append 必须真的被调用过，否则下面所有 not.toContain 都是假绿（首版就这么翻过车）
    expect(cs.append, 'append 未被调用 ⇒ 后续 not.toContain 断言全为空过').toHaveBeenCalled();
    const appended = JSON.stringify(cs.append.mock.calls.map((c) => c[1]));
    // ★ 核心：base64 绝不落盘（改造前 loop.ts 把渠道图 base64 直接 append 进历史 ⇒ 每轮重发）
    expect(appended, '渠道图 base64 落进了历史 —— 会被每轮重发').not.toContain(SENTINEL);
    expect(appended, '落盘的 user 消息不该带 image 块').not.toContain('"type":"image"');
    expect(appended, '应落一行剥离标记').toContain('MediaStripped');
    expect(appended, '渠道图无本地路径 ⇒ 标记提示重发').toContain('渠道附图');

    // 模型本轮确实看到了图（context 阶段把它注入了 compose 的历史）
    const composer = (services as unknown as { contextComposer: { compose: ReturnType<typeof vi.fn> } }).contextComposer;
    const composed = JSON.stringify(composer.compose.mock.calls.map((c) => c[0]?.history));
    expect(composed, '图没进本轮请求 ⇒ 模型根本没看到').toContain(SENTINEL);
    expect(composed).toContain('"type":"image"');

    // 一次性消费
    expect((loop as unknown as { channelImages: unknown }).channelImages).toBeNull();
  });
});