/**
 * P1 M3 · finalize 阶段模块测试（builtin:turn-finalize）。
 * 覆盖：toolCalled 分支 / flowStillActive 分支 / 正常停止（stop 事件落盘）/
 * turnRecorder 缺省跳过 / 契约声明满足槽位 requires。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFinalizeStage, FINALIZE_STAGE_ID } from './finalize.js';
import { checkContract, type SlotSpec, type StageContext } from '../../kernel/pipeline.js';
import { createTurnState, type TurnState } from '../turn-state.js';

function makeCtx(services: Record<string, unknown>): StageContext<any> {
  return {
    iteration: 1,
    get: <T = unknown>(k: string) => services[k] as T | undefined,
    require: <T = unknown>(k: string) => services[k] as T,
    config: <T = Record<string, unknown>>() => ({}) as T,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
}

function baseState(): TurnState {
  return createTurnState({
    turn: 1,
    history: [],
    userInput: '',
    session: {
      sessionDir: '/tmp/test-session',
      currentSummary: undefined,
      recentToolNames: [],
      activePlan: undefined,
    } as never,
  });
}

function tmpSessionDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-test-'));
}

const stage = createFinalizeStage();

describe('finalize 阶段（builtin:turn-finalize）', () => {
  it('工具调用轮：endTurn 被调、不写 stop 事件、返回 stop:false + toolCalled:true', async () => {
    const endTurn = vi.fn().mockResolvedValue(null);
    const sessionDir = tmpSessionDir();
    const ctx = makeCtx({ turnRecorder: { endTurn }, sessionDir });

    const st = await stage.run({ ...baseState(), toolCalled: true }, ctx);

    expect(endTurn).toHaveBeenCalledTimes(1);
    expect(st.stop).toBe(false);
    expect(st.toolCalled).toBe(true);
    // 无 stop 事件落盘
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    expect(fs.existsSync(eventsFile)).toBe(false);
  });

  it('flow 活跃轮：endTurn 被调、不写 stop 事件、返回 stop:false', async () => {
    const endTurn = vi.fn().mockResolvedValue(null);
    const sessionDir = tmpSessionDir();
    const ctx = makeCtx({ turnRecorder: { endTurn }, sessionDir });

    const st = await stage.run({ ...baseState(), flowStillActive: true }, ctx);

    expect(endTurn).toHaveBeenCalledTimes(1);
    expect(st.stop).toBe(false);
    expect(st.toolCalled).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, 'events.jsonl'))).toBe(false);
  });

  it('正常结束：endTurn 被调、只返回暂定 stop（stop 事件由 driver 单写）', async () => {
    const endTurn = vi.fn().mockResolvedValue(null);
    const sessionDir = tmpSessionDir();
    const ctx = makeCtx({ turnRecorder: { endTurn }, sessionDir });

    const st = await stage.run({ ...baseState(), stop: true, stopReason: 'end_turn' }, ctx);

    expect(endTurn).toHaveBeenCalledTimes(1);
    expect(st.stop).toBe(true);
    expect(st.stopReason).toBe('end_turn');
    // finalize 不落盘：截断/异步/门链之后才由 _runInternal 统一写一条 stop。
    expect(fs.existsSync(path.join(sessionDir, 'events.jsonl'))).toBe(false);
  });

  // ── say 工具（2026-09-18）──
  // 关键：report 本身也是一次工具调用（toolCalled=true），判定必须排在它之前，
  // 否则"调用了 report 却停不下来"。以下两条用例锁定这个顺序语义。
  it('report 已提交：即使 toolCalled=true 也停（say_submitted），事件留给 driver', async () => {
    const endTurn = vi.fn().mockResolvedValue(null);
    const sessionDir = tmpSessionDir();
    const ctx = makeCtx({ turnRecorder: { endTurn }, sessionDir });

    const st = await stage.run(
      { ...baseState(), toolCalled: true, sayStatus: 'submitted' },
      ctx,
    );

    expect(st.stop).toBe(true);
    expect(st.stopReason).toBe('say_submitted');
    expect(fs.existsSync(path.join(sessionDir, 'events.jsonl'))).toBe(false);
  });

  it('say 连续失败中止：stop=true + say_failed（不再空转到 maxTurns）', async () => {
    const sessionDir = tmpSessionDir();
    const ctx = makeCtx({ turnRecorder: { endTurn: vi.fn().mockResolvedValue(null) }, sessionDir });

    const st = await stage.run({ ...baseState(), toolCalled: true, sayStatus: 'aborted' }, ctx);

    expect(st.stop).toBe(true);
    expect(st.stopReason).toBe('say_failed');
  });

  it('未提交 report 时行为不变（toolCalled 分支优先于默认结束）', async () => {
    const sessionDir = tmpSessionDir();
    const ctx = makeCtx({ sessionDir });

    const st = await stage.run({ ...baseState(), toolCalled: true }, ctx);

    expect(st.stop).toBe(false);
    expect(st.toolCalled).toBe(true);
  });

  it('无 turnRecorder 服务时跳过回合记账（不抛错）', async () => {
    const sessionDir = tmpSessionDir();
    const ctx = makeCtx({ sessionDir });

    const st = await stage.run({ ...baseState(), toolCalled: true }, ctx);

    expect(st.stop).toBe(false);
    expect(st.toolCalled).toBe(true);
  });

  it('契约：模块声明满足配置骨架 finalize 槽位的 requires', () => {
    const slot: SlotSpec = {
      id: 'finalize',
      impl: FINALIZE_STAGE_ID,
      requires: { reads: ['stop'], writes: ['stop', 'stopReason'] },
    };
    expect(checkContract(slot, stage)).toEqual([]);
  });
});
