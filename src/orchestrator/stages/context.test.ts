/**
 * P1 M4 · context 阶段模块测试（builtin:layered-composer）。
 * 覆盖：工具过滤（白/黑名单）/ effectiveHistory（router 过滤）/ 图片注入 /
 * compose 参数透传 / 压缩触发（阈值内不触发、超阈值异步触发）/ 契约校验。
 */
import { describe, it, expect, vi } from 'vitest';
import { createContextStage, CONTEXT_STAGE_ID } from './context.js';
import { checkContract, type SlotSpec, type StageContext } from '../../kernel/pipeline.js';
import { createTurnState, type TurnState } from '../turn-state.js';
import type { Message } from '../../types.js';

/** 构造完整服务表（context 模块 require 的服务全量提供） */
function makeCtx(overrides: Record<string, unknown> = {}): StageContext<any> {
  const base: Record<string, unknown> = {
    conversationStore: {
      readAll: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue(undefined),
      replace: vi.fn().mockResolvedValue(undefined),
    },
    toolRegistry: {
      getToolDefinitions: vi.fn().mockReturnValue([
        { name: 'a', description: 'A' },
        { name: 'b', description: 'B' },
        { name: 'c', description: 'C' },
      ]),
    },
    contextComposer: {
      compose: vi.fn().mockResolvedValue({
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
        zoneBreakdown: { total: 100 },
      }),
      activeConditions: new Set<string>(),
    },
    compressor: { compress: vi.fn().mockResolvedValue(null) },
    summaryStore: { save: vi.fn().mockResolvedValue(undefined) },
    statsManager: { increment: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) },
    configCenter: { get: vi.fn() },
    gitManager: {},
    maxContextTokens: 8000,
    sessionDir: '/tmp/ctx-test',
    loopHooks: { emit: vi.fn().mockResolvedValue(undefined) },
    getRouter: () => ({
      name: 'normal',
      toolAllowlist: [],
      toolBlacklist: [],
      filterHistory: (h: Message[]) => h,
    }),
    clusterTransform: () => Promise.resolve(null),
    deepCompressRestore: () => {},
    kbState: { lastQuery: '' },
    outputHandler: null,
    bundleRegistry: undefined,
    personaDir: undefined,
    ...overrides,
  };
  return {
    iteration: 1,
    get: <T = unknown>(k: string) => base[k] as T | undefined,
    require: <T = unknown>(k: string) => base[k] as T,
    config: <T = Record<string, unknown>>() => ({}) as T,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
}

const provider = (opts: { vision?: boolean; type?: string } = {}) => ({
  getProviderType: () => opts.type ?? 'deepseek',
  getModel: () => 'deepseek-chat',
  getCapabilities: () => ({ vision: opts.vision ?? false }),
});

function baseState(over: Partial<TurnState> = {}): TurnState {
  const s = createTurnState({
    turn: 1,
    history: [],
    userInput: '你好',
    session: {
      sessionDir: '/tmp/ctx-test',
      currentSummary: undefined,
      recentToolNames: [],
      activePlan: undefined,
    } as never,
  });
  s.userInput = '你好';
  s.activeProvider = provider() as never;
  return { ...s, ...over } as TurnState;
}

const stage = createContextStage();

describe('context 阶段（builtin:layered-composer）', () => {
  it('工具过滤：白名单生效，黑名单始终过滤', async () => {
    const ctx = makeCtx({
      getRouter: () => ({
        name: 'normal',
        toolAllowlist: ['a', 'b'],
        toolBlacklist: ['b'],
        filterHistory: (h: Message[]) => h,
      }),
    });

    const st = await stage.run(baseState(), ctx);

    expect(st.toolDefinitions.map((t) => t.name)).toEqual(['a']);
  });

  it('工具过滤：bundleRegistry 注入时只暴露激活包工具（回归：setBundleRegistry 须同步 stageServices）', async () => {
    // bundleRegistry 存在（已注入）→ 激活包 = common+coding，只放行包内工具。
    // 此用例对应 bug：loop.setBundleRegistry 若未同步 stageServices，
    // ctx.get('bundleRegistry') 为 undefined，过滤被跳过 → 全量工具暴露。
    const ctx = makeCtx({
      getRouter: () => ({ name: 'normal', toolAllowlist: [], toolBlacklist: [], filterHistory: (h: Message[]) => h }),
      bundleRegistry: {
        getActiveToolNames: () => ['a', 'c'], // 模拟 coding 包（a/c 在包内，b 不在）
      },
    });

    const st = await stage.run(baseState(), ctx);

    // b 不在激活包 → 被过滤掉
    expect(st.toolDefinitions.map((t) => t.name)).toEqual(['a', 'c']);
  });

  it('工具过滤：bundleRegistry 未注入时（undefined）不过滤（全量）', async () => {
    const ctx = makeCtx({
      getRouter: () => ({ name: 'normal', toolAllowlist: [], toolBlacklist: [], filterHistory: (h: Message[]) => h }),
      bundleRegistry: undefined, // 构造时未注入（旧 bug 场景）
    });

    const st = await stage.run(baseState(), ctx);

    // undefined → 跳过过滤，全量工具保留（此时由注入方保证 bundleRegistry 已同步）
    expect(st.toolDefinitions.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('effectiveHistory：router.filterHistory 过滤后传给 compose', async () => {
    const filterHistory = vi.fn((h: Message[]) => h.slice(1));
    const compose = vi.fn().mockResolvedValue({
      messages: [{ role: 'assistant', content: 'ok' }],
      zoneBreakdown: { total: 50 },
    });
    const ctx = makeCtx({
      getRouter: () => ({ name: 'normal', toolAllowlist: [], toolBlacklist: [], filterHistory }),
      contextComposer: { compose, activeConditions: new Set() },
    });
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'drop me' }] },
      { role: 'user', content: [{ type: 'text', text: 'keep me' }] },
    ];

    await stage.run(baseState({ history, historyWithoutLastUser: history }), ctx);

    expect(filterHistory).toHaveBeenCalledWith(history);
    expect(compose).toHaveBeenCalledWith(expect.objectContaining({ history: [history[1]] }));
  });

  it('图片注入：vision 模型时 pendingImageInjections 写入历史并落盘', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      conversationStore: { readAll: vi.fn(), append, replace: vi.fn() },
    });
    const st = await stage.run(
      baseState({
        activeProvider: provider({ vision: true }) as never,
        pendingImageInjections: [
          { imgId: 'img1', data: 'base64data', media_type: 'image/png' } as never,
        ],
      }),
      ctx,
    );

    expect(append).toHaveBeenCalledTimes(1);
    // compose 收到含图片消息的历史
    const composeArg = (ctx as never as { require(k: string): { compose: ReturnType<typeof vi.fn> } }).require('contextComposer').compose;
    const historyArg = composeArg.mock.calls[0][0].history as Message[];
    expect(JSON.stringify(historyArg)).toContain('"image"');
    expect(st.pendingImageInjections.length).toBe(1); // 调用方负责清空原数组
  });

  it('压缩不触发：token 低于阈值时 compressor.compress 不被调用', async () => {
    const compress = vi.fn().mockResolvedValue(null);
    const ctx = makeCtx({ compressor: { compress } });

    const st = await stage.run(baseState(), ctx);

    expect(compress).not.toHaveBeenCalled();
    expect(st.pendingCompression).toBeNull();
    expect(st.lastContextTokens).toBe(100);
  });

  it('压缩触发：token 超阈值 → 异步后台压缩挂到 state.pendingCompression', async () => {
    const compress = vi.fn().mockResolvedValue(null);
    const ctx = makeCtx({
      compressor: { compress },
      contextComposer: {
        compose: vi.fn().mockResolvedValue({
          messages: [{ role: 'assistant', content: 'hi' }],
          zoneBreakdown: { total: 7000 }, // 8000*0.75=6000 → 超阈值
        }),
        activeConditions: new Set(),
      },
    });

    const st = await stage.run(
      baseState({
        uncompressedMsgs: [{ role: 'user', content: [{ type: 'text', text: 'recent' }] } as never],
      }),
      ctx,
    );

    expect(compress).toHaveBeenCalledTimes(1);
    expect(st.pendingCompression).toBeInstanceOf(Promise);
    expect(st.needsCompression).toBe(false);
  });

  it('契约：模块声明满足配置骨架 context 槽位的 requires', () => {
    const slot: SlotSpec = {
      id: 'context',
      impl: CONTEXT_STAGE_ID,
      requires: { reads: ['history', 'userInput', 'tools'], writes: ['messages', 'zoneBreakdown'] },
    };
    expect(checkContract(slot, stage)).toEqual([]);
  });
});
