/**
 * P1 M5 · tools 阶段模块测试（builtin:tool-dispatch）。
 * 覆盖：无工具调用原样穿过 / 有工具时执行调度（钩子顺序、inline flush 分支、
 * executeTools 分支、plan 更新）/ 契约校验。
 */
import { describe, it, expect, vi } from 'vitest';
import { createToolsStage, TOOLS_STAGE_ID } from './tools.js';
import { checkContract, type SlotSpec, type StageContext } from '../../kernel/pipeline.js';
import { createTurnState, type TurnState } from '../turn-state.js';
import type { ToolCall } from '../../types.js';

function makeCtx(overrides: Record<string, unknown> = {}): StageContext<any> {
  const base: Record<string, unknown> = {
    loopHooks: { emit: vi.fn().mockResolvedValue(undefined) },
    orchestrator: { updatePlanProgress: vi.fn((plan: unknown) => plan) },
    toolService: {
      flushInline: vi.fn().mockResolvedValue([]),
      executeTools: vi.fn().mockResolvedValue([]),
    },
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
    userInput: '',
    session: {
      sessionDir: '/tmp/tools-test',
      currentSummary: undefined,
      recentToolNames: [],
      activePlan: undefined,
    } as never,
  });
  return { ...s, ...over } as TurnState;
}

const toolCalls: ToolCall[] = [
  { id: 't1', name: 'weather', input: { city: '北京' } },
];

const stage = createToolsStage();

describe('tools 阶段（builtin:tool-dispatch）', () => {
  it('无工具调用：原样穿过，toolCalled=false，执行服务不被调', async () => {
    const toolService = { executeTools: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeCtx({ toolService });

    const st = await stage.run(baseState({ toolCalls: [] }), ctx);

    expect(st.toolCalled).toBe(false);
    expect(toolService.executeTools).not.toHaveBeenCalled();
  });

  it('有工具调用：recentToolNames → plan 更新 → executeTools → afterToolExecute（beforeToolExecute 门禁已下沉到执行入口 loop-tools）', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const toolService = {
      executeTools: vi.fn().mockResolvedValue([{ id: 't1', name: 'weather', ok: true }]),
    };
    const updatePlanProgress = vi.fn((plan: unknown) => ({ ...(plan as object), updated: true }));
    const activePlan = { steps: [] } as never;
    const ctx = makeCtx({ loopHooks: { emit }, toolService, orchestrator: { updatePlanProgress } });

    const st = await stage.run(baseState({ toolCalls, activePlan }), ctx);

    // 安全门禁契约（kernel/security P0）：beforeToolExecute 由 runToolDispatch /
    // runToolInline 在执行入口消费（可拒绝），阶段层只发 afterToolExecute 观察钩子
    const hookNames = emit.mock.calls.map((c) => c[0]);
    expect(hookNames).toEqual(['afterToolExecute']);
    // plan 更新 + recentToolNames
    expect(updatePlanProgress).toHaveBeenCalledWith(activePlan, 'weather');
    expect(st.recentToolNames).toEqual(['weather']);
    // executeTools 分支（非 inline）
    expect(toolService.executeTools).toHaveBeenCalledWith(toolCalls);
    expect(st.toolCalled).toBe(true);
    // afterToolExecute payload 带真实执行摘要（P2：ok 来自 executeTools 返回）
    expect(emit.mock.calls[0][1]).toMatchObject({
      results: [{ id: 't1', name: 'weather', ok: true }],
    });
  });

  it('inline 已执行：走 flushInline 分支，返回清空后的 inlineToolResults', async () => {
    const toolService = {
      flushInline: vi.fn().mockResolvedValue(undefined),
      executeTools: vi.fn().mockResolvedValue(undefined),
    };
    const ctx = makeCtx({ toolService });
    const results = new Map([['t1', { content: '晴', isError: false }]]);

    const st = await stage.run(baseState({ toolCalls, inlineToolExecuted: true, inlineToolResults: results }), ctx);

    expect(toolService.flushInline).toHaveBeenCalledWith(toolCalls);
    expect(toolService.executeTools).not.toHaveBeenCalled();
    expect(st.inlineToolExecuted).toBe(false);
    expect(st.inlineToolResults.size).toBe(0);
  });

  it('契约：模块声明满足配置骨架 tools 槽位的 requires', () => {
    const slot: SlotSpec = {
      id: 'tools',
      impl: TOOLS_STAGE_ID,
      requires: { reads: ['toolCalls'], writes: ['toolCalled'] },
    };
    expect(checkContract(slot, stage)).toEqual([]);
  });
});
