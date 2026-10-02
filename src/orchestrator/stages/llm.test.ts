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

  it('参数截断保护（C）：incomplete 的 tool_use 不执行，改为回注合成 tool_result', async () => {
    const provider = mkProvider([
      { type: 'TOOL_USE', id: 'trunc1', name: 'write', input: { file_path: 'a.ts', content: 'half' }, incomplete: true },
      { type: 'TOOL_USE', id: 'ok1', name: 'read', input: { file_path: 'b.ts' } },
      { type: 'STOP', reason: 'length' },
    ]);
    const toolService = { executeSingleInline: vi.fn().mockResolvedValue(undefined) };
    const onToolResult = vi.fn();
    const ctx = makeCtx({
      toolService,
      outputHandler: { onToolResult, onToolUse: vi.fn(), onText: vi.fn(), onThinking: vi.fn(), onFlush: vi.fn(), onTurnStart: vi.fn() },
    });

    const st = await stage.run(baseState({ activeProvider: provider as never }), ctx);

    // 只有**未**截断的那个被执行
    expect(toolService.executeSingleInline).toHaveBeenCalledTimes(1);
    expect(toolService.executeSingleInline).toHaveBeenCalledWith('ok1', 'read', { file_path: 'b.ts' });
    // 截断的那个仍留在 toolCalls —— assistant 的 tool_use ↔ tool_result 配对不能断
    expect(st.toolCalls.map((c) => c.id)).toEqual(['trunc1', 'ok1']);
    // 合成结果已入表，且标记为错误
    const stored = st.inlineToolResults.get('trunc1');
    expect(stored?.isError).toBe(true);
    expect(stored?.content).toContain('NOT executed');
    expect(onToolResult).toHaveBeenCalledWith(expect.stringContaining('NOT executed'), true, 'trunc1');
    // 走的是 inline 路径 ⇒ tools 阶段会 flushInline，而不会退回 executeTools 再执行一遍
    expect(st.inlineToolExecuted).toBe(true);
  });

  it('max_tokens 下发：仅当配置里**有**该键才调 setter（未设置时不动，避免冲掉构造期覆盖）', async () => {
    const mk = (cfgValue: unknown) => {
      const provider = mkProvider([{ type: 'TEXT', content: 'x' }]);
      (provider as Record<string, unknown>).setMaxOutputTokens = vi.fn();
      const ctx = makeCtx({
        configCenter: { get: vi.fn((k: string) => (k === 'provider.maxOutputTokens' ? cfgValue : undefined)) },
      });
      return { provider, ctx };
    };

    // ① 未设置（undefined）⇒ 不调用。否则会把 switch_provider 带 api_key 时的
    //    一次性 max_tokens（构造期覆盖、不经 setter）静默冲掉。
    const a = mk(undefined);
    await stage.run(baseState({ activeProvider: a.provider as never }), a.ctx);
    expect((a.provider as never as { setMaxOutputTokens: ReturnType<typeof vi.fn> }).setMaxOutputTokens).not.toHaveBeenCalled();

    // ② 正数 ⇒ 原样下发
    const b = mk(4096);
    await stage.run(baseState({ activeProvider: b.provider as never }), b.ctx);
    expect((b.provider as never as { setMaxOutputTokens: ReturnType<typeof vi.fn> }).setMaxOutputTokens).toHaveBeenCalledWith(4096);

    // ③ 0 ⇒ “复原为模型上限”（具体值取自模型目录，故只断言是数字）
    const c = mk(0);
    await stage.run(baseState({ activeProvider: c.provider as never }), c.ctx);
    expect((c.provider as never as { setMaxOutputTokens: ReturnType<typeof vi.fn> }).setMaxOutputTokens).toHaveBeenCalledWith(expect.any(Number));
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
