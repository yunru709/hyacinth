/**
 * loop-hooks.contract.test.ts — 主循环钩子的契约守卫（Phase 6 第 2 步 · 守卫②）
 *
 * 两层锁：
 *   ① **钩子名清单**（运行时）：10 个名字逐个钉死 —— 增删即红；
 *   ② **载荷形状**（类型级）：每个钩子的字段逐字构造一次 —— **字段增删即编译失败**。
 *      为什么用类型级而不是运行时断言：形状在运行时已被擦除，没有"形状"可查；
 *      而契约的意义正是"改上游就坏下游要在**编译期**暴露"，不是等跑到某个分支才炸。
 *      （做法：对象字面量赋给 `LoopHooks['<name>']` —— 少字段报错、多字段报"多余属性"错误。
 *        故**新增必填字段**与**删除字段**都会红。）
 *
 * 防的是运行时层的"改上游坏下游"：订阅者按 payload 字段办事，
 * 上游悄悄改字段名/结构，订阅者会读到 undefined 而**静默出错**。
 */
import { describe, expect, it } from 'vitest';
import { LOOP_HOOK_NAMES } from './loop-hooks.js';
import type { LoopHooks } from './loop-hooks.js';

describe('① 钩子名清单（运行时）', () => {
  it('10 个钩子名逐个钉死 —— 增删即红', () => {
    expect([...LOOP_HOOK_NAMES]).toEqual([
      'onTurnStart',
      'beforeContextAssemble',
      'afterContextAssemble',
      'onStreamEvent',
      'beforeToolExecute',
      'afterToolExecute',
      'beforeIterationEnd',
      'onIterationEnd',
      'onTurnEnd',
      'onTurnError',
    ]);
  });

  it('清单与 LoopHooks 键一一对应（清单不得漏项/多项）', () => {
    // 类型层面 LOOP_HOOK_NAMES 已 satisfies keyof LoopHooks；这里补运行时一致性：
    // 清单长度 = 10，且无重复
    expect(new Set(LOOP_HOOK_NAMES).size).toBe(LOOP_HOOK_NAMES.length);
    expect(LOOP_HOOK_NAMES.length).toBe(10);
  });
});

describe('② 载荷形状（类型级；字段增删即编译失败）', () => {
  it('10 个钩子的载荷逐字构造', () => {
    const onTurnStart: LoopHooks['onTurnStart'] = { turn: 1 };
    const beforeContextAssemble: LoopHooks['beforeContextAssemble'] = {
      turn: 1,
      userInput: 'hi',
      history: [],
      toolNames: [],
    };
    const afterContextAssemble: LoopHooks['afterContextAssemble'] = { turn: 1, messages: [], tokens: 0 };
    const onStreamEvent: LoopHooks['onStreamEvent'] = { turn: 1, event: null };
    const beforeToolExecute: LoopHooks['beforeToolExecute'] = { turn: 1, calls: [] };
    const afterToolExecute: LoopHooks['afterToolExecute'] = { turn: 1, results: [] };
    const beforeIterationEnd: LoopHooks['beforeIterationEnd'] = { turn: 1, stop: false };
    const onIterationEnd: LoopHooks['onIterationEnd'] = { turn: 1, stop: true, stopReason: 'end_turn' };
    const onTurnEnd: LoopHooks['onTurnEnd'] = { turn: 1, tokensUsed: 10, stopReason: 'end_turn' };
    const onTurnError: LoopHooks['onTurnError'] = { turn: 1, error: new Error('x') };

    // 逐项 touch（避免 unused；同时确保上面 10 个构造确实被执行）
    for (const p of [
      onTurnStart,
      beforeContextAssemble,
      afterContextAssemble,
      onStreamEvent,
      beforeToolExecute,
      afterToolExecute,
      beforeIterationEnd,
      onIterationEnd,
      onTurnEnd,
      onTurnError,
    ]) {
      expect(p).toBeTruthy();
    }
  });
});
