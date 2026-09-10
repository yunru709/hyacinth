/**
 * P1 M5 · llm 阶段模块测试（builtin:provider-stream）。
 * 覆盖：流消费（TEXT/THINKING/TOOL_USE/USAGE/STOP 路由）/ toolCalls 收集与 inline 执行闭包 /
 * cache 统计归一化 / 去重（last-wins）/ assistant 消息落盘 / 契约校验。
 */
import { describe, it, expect, vi } from 'vitest';
import { createLlmStage, LLM_STAGE_ID } from './llm.js';
import { checkContract, type SlotSpec, type StageContext } from '../../kernel/pipeline.js';
import { createTurnState, type TurnState } from '../turn-state.js';

type StreamEvent = Record<string, unknown> & { type: string };

/** 构造 async iterable 流 */
function mkStream(events: StreamEvent[]) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function makeCtx(overrides: Record<string, unknown> = {}): StageContext<any> {
  const base: Record<string, unknown> = {
    conversationStore: {
      readAll: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue(undefined),
      replace: vi.fn().mockResolvedValue(undefined),
    },
    eventStore: { append: vi.fn().mockResolvedValue(undefined) },
    statsManager: {
      get: vi.fn().mockResolvedValue({ input_tokens: 10, output_tokens: 20, cache_turns: [] }),
      update: vi.fn().mockResolvedValue(undefined),
      increment: vi.fn().mockResolvedValue(undefined),
    },
    configCenter: { get: vi.fn() },
    sessionDir: '/tmp/llm-test',
    loopHooks: { emit: vi.fn().mockResolvedValue(undefined) },
    outputHandler: null,
    toolService: { executeSingleInline: vi.fn().mockResolvedValue(undefined) },
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

function mkProvider(events: StreamEvent[]) {
  return {
    getProviderType: () => 'deepseek',
    getModel: () => 'deepseek-chat',
    setThinking: vi.fn(),
    getCapabilities: () => ({}),
    createStream: vi.fn().mockReturnValue(mkStream(events)),
  };
}

function baseState(over: Partial<TurnState> = {}): TurnState {
  const s = createTurnState({
    turn: 1,
    history: [],
    userInput: '你好',
    session: {
      sessionDir: '/tmp/llm-test',
      currentSummary: undefined,
      recentToolNames: [],
      activePlan: undefined,
    } as never,
  });
  s.activeProvider = { getProviderType: () => 'deepseek', getModel: () => 'deepseek-chat' } as never;
  s.messages = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
  s.toolDefinitions = [];
  return { ...s, ...over } as TurnState;
}

const stage = createLlmStage();

describe('llm 阶段（builtin:provider-stream）', () => {
  it('流消费：TEXT 拼装 streamText、STOP 记录 stopReason、usage 累计', async () => {
    const provider = mkProvider([
      { type: 'TEXT', content: '你好' },
      { type: 'TEXT', content: '世界' },
      { type: 'USAGE', input_tokens: 100, output_tokens: 50 },
      { type: 'STOP', reason: 'end_turn' },
    ]);
    const append = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({});

    const st = await stage.run(baseState({ activeProvider: provider as never }), ctx);

    expect(st.streamText).toBe('你好世界');
    expect(st.stopReason).toBe('end_turn');
    // assistant 消息落盘（含 text 块）
    const store = ctx.require('conversationStore') as { append: ReturnType<typeof vi.fn> };
    expect(store.append).toHaveBeenCalledWith(
      '/tmp/llm-test',
      expect.objectContaining({ role: 'assistant' }),
    );
    // stats 累计：10 + 100 / 20 + 50
    const statsManager = ctx.require('statsManager') as { update: ReturnType<typeof vi.fn> };
    expect(statsManager.update).toHaveBeenCalledWith('/tmp/llm-test', expect.objectContaining({
      input_tokens: 110,
      output_tokens: 70,
    }));
  });

  it('TOOL_USE 流内执行：toolCalls 收集 + inline 闭包被调 + 去重 last-wins', async () => {
    const provider = mkProvider([
      { type: 'TOOL_USE', id: 't1', name: 'weather', input: { city: '北京' } },
      { type: 'TOOL_USE', id: 't2', name: 'weather', input: { city: '北京' } }, // 重复（重试残留）
      { type: 'TOOL_USE', id: 't3', name: 'time', input: {} },
    ]);
    const toolService = { executeSingleInline: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeCtx({ toolService });

    const st = await stage.run(baseState({ activeProvider: provider as never }), ctx);

    // 去重：weather(北京) 保留 last-wins → t2
    expect(st.toolCalls.map((c) => c.id)).toEqual(['t2', 't3']);
    expect(toolService.executeSingleInline).toHaveBeenCalledTimes(3);
    expect(st.inlineToolExecuted).toBe(true);
  });

  it('cache 统计：DeepSeek 格式（hit/miss）直接使用，Anthropic 格式推导', async () => {
    const provider = mkProvider([
      { type: 'USAGE', input_tokens: 100, output_tokens: 10, cache_hit_tokens: 80, cache_miss_tokens: 20 },
      { type: 'STOP', reason: 'end_turn' },
    ]);
    const ctx = makeCtx({});
    const state = baseState({ activeProvider: provider as never });
    state.cacheStats.logHits = true;

    const st = await stage.run(state, ctx);

    expect(st.cacheStats.hitTokens).toBe(80);
    expect(st.cacheStats.missTokens).toBe(20);
    expect(st.cacheStats.turns).toHaveLength(1);
    expect(st.cacheStats.turns[0]).toMatchObject({ hitTokens: 80, missTokens: 20, hitRate: 80 });
  });

  it('thinking-only 兜底：text 为空时 thinking 提升为 text', async () => {
    const provider = mkStreamEvents([{ type: 'THINKING', content: '让我想想' }]);
    const onText = vi.fn();
    const ctx = makeCtx({ outputHandler: { onText, onThinking: vi.fn(), onFlush: vi.fn(), onToolUse: vi.fn(), onTurnStart: vi.fn() } });

    const st = await stage.run(baseState({ activeProvider: provider as never }), ctx);

    expect(st.streamText).toBe('让我想想');
    expect(onText).toHaveBeenCalledWith('让我想想');
  });

  it('契约：模块声明满足配置骨架 llm 槽位的 requires', () => {
    const slot: SlotSpec = {
      id: 'llm',
      impl: LLM_STAGE_ID,
      requires: { reads: ['messages'], writes: ['streamText', 'stopReason'] },
    };
    expect(checkContract(slot, stage)).toEqual([]);
  });
});

/** 便捷：把事件数组包装成 provider 流 */
function mkStreamEvents(events: StreamEvent[]) {
  const provider = mkProvider(events);
  return provider;
}
