/**
 * automation-loop-bridge 测试（T2，2026-10-31）
 *
 * 锁死的核心语义（复核报告 §四 验收面）：
 *   1. 白名单进桥（onStreamEvent 不进）
 *   2. afterToolExecute 按 result 扇出 —— write+bash 混合批 = 两个合法的不同发生
 *   3. eventId 去重：同发生只投一次；**turn 每用户回合重置 ⇒ 不能拿 turn 当
 *      iteration 型钩子的去重键**（每次对话只有一轮是常态，onTurnEnd:1 跨回合碰撞）
 *   4. 大对象（history / messages / 完整 tool input）不出桥
 */

import { describe, expect, it, vi } from 'vitest';

import { HookBus } from '../kernel/hook-bus.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import {
  LOOP_BRIDGE_HOOK_NAMES,
  bridgeLoopHooks,
  type LoopBridgeEvent,
} from './automation-loop-bridge.js';

function setup() {
  const hooks = new HookBus<LoopHooks>({ name: 'test' });
  const fired: LoopBridgeEvent[] = [];
  const bridge = bridgeLoopHooks({
    hooks,
    getSessionId: () => 's1',
    fire: (e) => {
      fired.push(e);
    },
  });
  return { hooks, fired, bridge };
}

describe('白名单', () => {
  it('覆盖 9 个钩子，onStreamEvent 被剔除', () => {
    expect(LOOP_BRIDGE_HOOK_NAMES).toHaveLength(9);
    expect(LOOP_BRIDGE_HOOK_NAMES).not.toContain('onStreamEvent');
  });

  it('onStreamEvent emit 不出桥', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('onStreamEvent', { turn: 1, event: { type: 'TEXT' } });
    expect(fired).toEqual([]);
  });
});

describe('eventId 去重（iteration 型钩子）', () => {
  it('同 payload 重复 emit → 只投一次；iteration 变化 → 再投（合法新发生）', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('onTurnEnd', { turn: 3, tokensUsed: 10, stopReason: 'end_turn', iteration: 5 });
    await hooks.emit('onTurnEnd', { turn: 3, tokensUsed: 10, stopReason: 'end_turn', iteration: 5 });
    expect(fired).toHaveLength(1);
    expect(fired[0].name).toBe('onTurnEnd');
    expect(fired[0].eventId).toBe('s1:onTurnEnd:5');
    expect(fired[0].detail).toEqual({ turn: 3, iteration: 5, tokensUsed: 10, stopReason: 'end_turn' });

    await hooks.emit('onTurnEnd', { turn: 1, tokensUsed: 4, stopReason: 'end_turn', iteration: 6 });
    expect(fired).toHaveLength(2);
  });

  it('复核核心场景：连续两个"单轮"用户回合 → 两次 onTurnEnd 都必须投递（turn 都 =1，iteration 不同）', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('onTurnEnd', { turn: 1, tokensUsed: 1, iteration: 11 });
    await hooks.emit('onTurnEnd', { turn: 1, tokensUsed: 1, iteration: 12 });
    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.eventId)).toEqual(['s1:onTurnEnd:11', 's1:onTurnEnd:12']);
  });

  it('缺 iteration 字段（防御路径）→ 回退 turn；同 turn 重复 emit 仍被去重', async () => {
    const { hooks, fired } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hooks.emit('onTurnError', { turn: 2, error: new Error('boom') } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hooks.emit('onTurnError', { turn: 2, error: new Error('x') } as any);
    expect(fired).toHaveLength(1);
    expect(fired[0].eventId).toBe('s1:onTurnError:2');
  });

  it('onTurnError 的 Error → detail.error 收敛为 message 字符串', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('onTurnError', { turn: 1, error: new Error('LLM 炸了'), iteration: 3 });
    expect(fired[0].detail.error).toBe('LLM 炸了');
  });

  it('beforeIterationEnd / onIterationEnd / onTurnStart 同法（spot check）', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('beforeIterationEnd', { turn: 1, stop: false, iteration: 4 });
    await hooks.emit('onIterationEnd', { turn: 1, stop: true, stopReason: 'end_turn', iteration: 4 });
    await hooks.emit('onTurnStart', { turn: 4 }); // turn=currentTurn，turn 型键
    expect(fired.map((e) => e.eventId)).toEqual([
      's1:beforeIterationEnd:4',
      's1:onIterationEnd:4',
      's1:onTurnStart:4',
    ]);
  });
});

describe('afterToolExecute 按 result 扇出', () => {
  it('write+bash 混合批 → 两条事件，各带各自 toolUse id（合法的不同发生，不得互吞）', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('afterToolExecute', {
      turn: 2,
      results: [
        { id: 'tu_a', name: 'write', ok: true },
        { id: 'tu_b', name: 'bash', ok: false },
      ],
    });
    expect(fired).toHaveLength(2);
    expect(fired[0]).toMatchObject({
      name: 'afterToolExecute:write',
      detail: { turn: 2, id: 'tu_a', tool: 'write', ok: true },
    });
    expect(fired[0].eventId).toBe('s1:afterToolExecute:tu_a');
    expect(fired[1]).toMatchObject({
      name: 'afterToolExecute:bash',
      detail: { turn: 2, id: 'tu_b', tool: 'bash', ok: false },
    });
    expect(fired[1].eventId).toBe('s1:afterToolExecute:tu_b');
  });

  it('同一批重复 emit（toolUse id 相同）→ 不再投递；新工具调用（新 id）→ 投递', async () => {
    const { hooks, fired } = setup();
    const batch = { turn: 1, results: [{ id: 'tu_1', name: 'write', ok: true }] };
    await hooks.emit('afterToolExecute', batch);
    await hooks.emit('afterToolExecute', batch);
    expect(fired).toHaveLength(1);
    await hooks.emit('afterToolExecute', { turn: 2, results: [{ id: 'tu_2', name: 'write', ok: true }] });
    expect(fired).toHaveLength(2);
  });

  it('空批 / results 缺失 → 零事件', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('afterToolExecute', { turn: 1, results: [] });
    expect(fired).toEqual([]);
  });
});

describe('beforeToolExecute（已核实 run 消费点会通知 observers）', () => {
  it('emit → 一条事件；calls 只出 id/name（完整 input 不出桥）', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('beforeToolExecute', {
      turn: 7,
      calls: [{ id: 't1', name: 'write', input: { file_path: 'x', content: 'HUGE' } } as never],
    });
    expect(fired).toHaveLength(1);
    expect(fired[0].eventId).toBe('s1:beforeToolExecute:7');
    expect(fired[0].detail.calls).toEqual([{ id: 't1', name: 'write' }]);
  });
});

describe('大对象不出桥', () => {
  it('beforeContextAssemble：history 不出桥、userInput 截 500', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('beforeContextAssemble', {
      turn: 1,
      userInput: 'x'.repeat(2000),
      history: [{ role: 'user', content: 'big' } as never],
      toolNames: ['say'],
    });
    expect(fired).toHaveLength(1);
    expect(fired[0].eventId).toBe('s1:beforeContextAssemble:1');
    expect((fired[0].detail.userInput as string)).toHaveLength(500);
    expect(fired[0].detail.history).toBeUndefined();
    expect(fired[0].detail.toolNames).toEqual(['say']);
  });

  it('afterContextAssemble：messages 不出桥，tokens 出', async () => {
    const { hooks, fired } = setup();
    await hooks.emit('afterContextAssemble', { turn: 1, messages: [{ role: 'user', content: 'big' } as never], tokens: 4321 });
    expect(fired[0].detail).toEqual({ turn: 1, tokens: 4321 });
  });
});

describe('会话 id 活取值与卸载', () => {
  it('每次事件现取 sessionId（会话切换后不陈旧）', async () => {
    const hooks = new HookBus<LoopHooks>({ name: 'test' });
    const fired: LoopBridgeEvent[] = [];
    let sid = 'old';
    bridgeLoopHooks({
      hooks,
      getSessionId: () => sid,
      fire: (e) => {
        fired.push(e);
      },
    });
    await hooks.emit('onTurnStart', { turn: 1 });
    sid = 'new';
    await hooks.emit('onTurnStart', { turn: 2 });
    expect(fired.map((e) => e.eventId)).toEqual(['old:onTurnStart:1', 'new:onTurnStart:2']);
  });

  it('dispose 后 emit 不再出桥', async () => {
    const { hooks, fired, bridge } = setup();
    bridge.dispose();
    await hooks.emit('onTurnStart', { turn: 1 });
    expect(fired).toEqual([]);
  });

  it('fire 抛错由 HookBus 隔离，不影响钩子总线其他挂载者', async () => {
    const hooks = new HookBus<LoopHooks>({ name: 'test' });
    const late: string[] = [];
    bridgeLoopHooks({
      hooks,
      getSessionId: () => 's1',
      fire: () => {
        throw new Error('hub down');
      },
      dedupCapacity: 8,
    });
    hooks.on('onTurnStart', () => {
      late.push('observed');
    });
    await expect(hooks.emit('onTurnStart', { turn: 1 })).resolves.toBeUndefined();
    expect(late).toEqual(['observed']);
  });
});

describe('LRU 容量', () => {
  it('超过容量淘汰最老 ⇒ 同 eventId 老键可再次投递', async () => {
    const hooks = new HookBus<LoopHooks>({ name: 'test' });
    const fired: LoopBridgeEvent[] = [];
    bridgeLoopHooks({
      hooks,
      getSessionId: () => 's1',
      fire: (e) => {
        fired.push(e);
      },
      dedupCapacity: 2,
    });
    await hooks.emit('onTurnStart', { turn: 1 }); // 键 A
    await hooks.emit('onTurnStart', { turn: 2 }); // 键 B
    await hooks.emit('onTurnStart', { turn: 3 }); // 键 C ⇒ 淘汰 A
    await hooks.emit('onTurnStart', { turn: 1 }); // A 已被淘汰 ⇒ 再投
    expect(fired.map((e) => e.eventId)).toEqual([
      's1:onTurnStart:1',
      's1:onTurnStart:2',
      's1:onTurnStart:3',
      's1:onTurnStart:1',
    ]);
  });
});
