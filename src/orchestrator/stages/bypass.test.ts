/**
 * P1 M6 · bypass 阶段模块测试（builtin:bypass-preturn）。
 * 覆盖：无管理器跳过 / 首轮 preTurn 改写 userInput + 注入缓存 / 意图消费（intent + 事件）/
 * 注入合并（缓存 + 运行时）/ 契约校验。
 */
import { describe, it, expect, vi } from 'vitest';
import { createBypassStage, BYPASS_STAGE_ID } from './bypass.js';
import { checkContract, type SlotSpec, type StageContext } from '../../kernel/pipeline.js';
import { createTurnState, type TurnState } from '../turn-state.js';
import type { Injection } from '../../bypass/types.js';

function makeCtx(overrides: Record<string, unknown> = {}): StageContext<any> {
  const base: Record<string, unknown> = {
    bypassManager: () => undefined,
    eventStore: { append: vi.fn().mockResolvedValue(undefined) },
    sessionDir: '/tmp/bypass-test/session-1',
    maxContextTokens: 8000,
    outputHandler: null,
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

function baseState(over: Partial<TurnState> = {}): TurnState {
  const s = createTurnState({
    turn: 1,
    history: [],
    userInput: '帮我写个函数',
    session: {
      sessionDir: '/tmp/bypass-test/session-1',
      currentSummary: undefined,
      recentToolNames: [],
      activePlan: undefined,
    } as never,
  });
  s.userInput = '帮我写个函数';
  return { ...s, ...over } as TurnState;
}

const stage = createBypassStage();

describe('bypass 阶段（builtin:bypass-preturn）', () => {
  it('无 bypassManager：跳过 preTurn，注入为空，userInput 原样', async () => {
    const st = await stage.run(baseState(), makeCtx());

    expect(st.userInput).toBe('帮我写个函数');
    expect(st.bypassInjections).toEqual([]);
    expect(st.bypassInjectionsCache).toBeUndefined();
    expect(st.intent).toBeNull();
  });

  it('首轮 preTurn：transformedInput 改写 userInput，注入写入缓存', async () => {
    const injections: Injection[] = [{ role: 'system', content: '旁路注入' }] as never;
    const preTurn = vi.fn().mockResolvedValue({
      transformedInput: '改写后的输入',
      injections,
      intent: undefined,
    });
    const ctx = makeCtx({ bypassManager: () => ({ preTurn, consumeInjections: () => [] }) });

    const st = await stage.run(baseState(), ctx);

    expect(st.userInput).toBe('改写后的输入');
    expect(st.bypassInjectionsCache).toBe(injections);
    expect(st.bypassInjections).toEqual(injections);
    expect(preTurn).toHaveBeenCalledTimes(1);
    expect(preTurn.mock.calls[0][0]).toMatchObject({
      userInput: '帮我写个函数',
      contextBudget: { used: 0, total: 8000 },
    });
  });

  it('缓存已建立（非首轮）：跳过 preTurn，仅合并运行时注入', async () => {
    const cached: Injection[] = [{ role: 'system', content: '缓存注入' }] as never;
    const runtime: Injection[] = [{ role: 'user', content: '运行时注入' }] as never;
    const preTurn = vi.fn();
    const consumeInjections = vi.fn().mockReturnValue(runtime);
    const ctx = makeCtx({ bypassManager: () => ({ preTurn, consumeInjections }) });

    const st = await stage.run(baseState({ bypassInjectionsCache: cached }), ctx);

    expect(preTurn).not.toHaveBeenCalled();
    expect(st.bypassInjections).toEqual([...cached, ...runtime]);
    expect(st.bypassInjectionsCache).toBe(cached); // 缓存不被覆盖
  });

  it('意图消费：intent + intentLabel + bypass_intent 事件', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const preTurn = vi.fn().mockResolvedValue({
      transformedInput: '查天气',
      injections: [],
      intent: { capability: 'tool_use', confidence: 0.9 },
    });
    const ctx = makeCtx({
      bypassManager: () => ({ preTurn, consumeInjections: () => [] }),
      eventStore: { append },
    });

    const st = await stage.run(baseState(), ctx);

    expect(st.intent).toEqual({ capability: 'tool_use', confidence: 0.9 });
    expect(st.intentLabel).toContain('[tool_use]');
    expect(st.intentLabel).toContain('查天气');
    expect(append).toHaveBeenCalledWith(
      '/tmp/bypass-test/session-1',
      expect.objectContaining({ type: 'bypass_intent', capability: 'tool_use', confidence: 0.9 }),
    );
  });

  it('契约：模块声明满足配置骨架 bypass 槽位的 requires', () => {
    const slot: SlotSpec = {
      id: 'bypass',
      impl: BYPASS_STAGE_ID,
      requires: { reads: ['history', 'userInput'], writes: ['userInput', 'bypassInjections'] },
    };
    expect(checkContract(slot, stage)).toEqual([]);
  });
});
