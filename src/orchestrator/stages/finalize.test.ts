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

  it('正常结束：endTurn 被调、stop 事件写入、返回 stop:true + stopReason', async () => {
    const endTurn = vi.fn().mockResolvedValue(null);
    const sessionDir = tmpSessionDir();
    const ctx = makeCtx({ turnRecorder: { endTurn }, sessionDir });

    const st = await stage.run({ ...baseState(), stop: true, stopReason: 'end_turn' }, ctx);

    expect(endTurn).toHaveBeenCalledTimes(1);
    expect(st.stop).toBe(true);
    expect(st.stopReason).toBe('end_turn');
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    expect(fs.existsSync(eventsFile)).toBe(true);
    const line = fs.readFileSync(eventsFile, 'utf8').trim();
    const evt = JSON.parse(line);
    expect(evt.type).toBe('stop');
    expect(evt.reason).toBe('end_turn');
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
