/**
 * 主循环钩子表（P1 状态收敛 M1）。
 *
 * 内核的 10 个钩子点声明（重构方案 §2.3）。这是 `HookBus` 的具体化：
 * `AgentLoop` 持有一条 `HookBus<LoopHooks>`，插件通过 `ctx.onHook/aroundHook`
 * 挂载观察者/拦截器，钩子列表在此集中声明 —— 这就是「接口在配置/声明中维护」的一部分。
 *
 * 命名即位置：钩子名 = runTurn 骨架中的位置（见方案 2.3 注释）。
 */

import { HookBus } from '../kernel/hook-bus.js';
import type { Message, ToolCall } from '../types.js';
import type { ToolExecSummary } from './turn-state.js';

/** 主循环 10 个钩子点及其 payload */
export interface LoopHooks extends Record<string, unknown> {
  /** 回合开始（currentTurn 自增之后） */
  onTurnStart: { turn: number };
  /** 上下文组装之前：旁路 preTurn、技能/MCP/记忆注入归位、工具列表过滤 */
  beforeContextAssemble: {
    turn: number;
    userInput: string;
    history: Message[];
    toolNames: string[];
  };
  /** 上下文组装之后：压缩触发策略可在此检查 tokens 决定压缩 */
  afterContextAssemble: {
    turn: number;
    messages: Message[];
    tokens: number;
  };
  /** LLM 流式事件（文本增量 / tool_use / finish）：scavenge 修复、事件落盘、inline 执行 */
  onStreamEvent: { turn: number; event: unknown };
  /** 工具执行之前：权限链、storm 抑制、turnRecorder 预录 */
  beforeToolExecute: { turn: number; calls: ToolCall[] };
  /** 工具执行之后：依赖影响面、resultBuffer、diff 通道 */
  afterToolExecute: { turn: number; results: ToolExecSummary[] };
  /** 迭代结束前（stop 判定已出）：bypass postTurn 迭代中审查 */
  beforeIterationEnd: { turn: number; stop: boolean; stopReason?: string };
  /** 迭代结束：异步子 Agent 注入、stats、loopGuard */
  onIterationEnd: { turn: number; stop: boolean; stopReason?: string };
  /** 回合结束：最终 postTurn、簇消费、图片回收 */
  onTurnEnd: { turn: number; tokensUsed: number; stopReason?: string };
  /** 回合异常（管道/LLM 抛错时兜底通知） */
  onTurnError: { turn: number; error: Error };
}

/** 钩子名清单 —— 供诊断/文档/UI 展示用，与 LoopHooks 键一一对应 */
export const LOOP_HOOK_NAMES = [
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
] as const satisfies ReadonlyArray<keyof LoopHooks>;

export type LoopHookBus = HookBus<LoopHooks>;

/** 创建主循环钩子总线（AgentLoop 构造时创建，factory 注入 PluginHost） */
export function createLoopHookBus(): LoopHookBus {
  return new HookBus<LoopHooks>({ name: 'loop' });
}
