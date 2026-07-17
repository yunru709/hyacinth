// ============================================================
// Machine Types — 通用状态机类型定义
// ============================================================
//
// 与业务无关的纯状态机基础设施。不包含 LLM/Flow 概念。
// Flow 层（flows/）在此基础上添加 getInjection、工具创建等。
// ============================================================

/**
 * MachineContext — 状态机携带的任意数据。
 * 由 Flow 层定义具体结构（如 TODO 的 steps、stepIndex、task）。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MachineContext {
  [key: string]: unknown;
}

/**
 * GuardResult — 守卫返回值。
 * 守卫不通过时，reason 会通过工具返回值告知模型。
 */
export interface GuardResult {
  ok: boolean;
  /** 不通过的原因（会展示给模型） */
  reason?: string;
}

/**
 * StateDef — 状态定义。
 */
export interface StateDef {
  /** 状态名（在 MachineDef.states 的 key 中已体现，此处可选） */
  name?: string;
  /** 人类可读标签，如 "规划中"，用于快照和日志 */
  label?: string;
  /** 进入该状态时的副作用（fire-and-forget，可同步可异步） */
  onEnter?: (ctx: MachineContext) => void | Promise<void>;
  /** 离开该状态时的副作用（fire-and-forget，可同步可异步） */
  onExit?: (ctx: MachineContext) => void | Promise<void>;
}

/**
 * TransitionDef — 转移定义。
 *
 * 转移按定义顺序匹配：runner.advance(event) 找到第一个
 * from 匹配 currentState 且 event 匹配的转移。
 */
export interface TransitionDef {
  /** 源状态（单个或多个） */
  from: string | string[];
  /** 目标状态 */
  to: string;
  /** 触发事件名 */
  event: string;
  /** 守卫：返回 { ok: false } 阻止转移 */
  guard?: (ctx: MachineContext) => GuardResult;
  /** 转移时的副作用（同步执行） */
  onTransition?: (ctx: MachineContext) => void;
}

/**
 * MachineDef — 状态机定义（纯数据，无行为）。
 *
 * 声明式的转移表，由 MachineRunner 执行。
 */
export interface MachineDef {
  /** 唯一标识（如 "todo"、"bootstrap"） */
  id: string;
  /** 初始状态名 */
  initial: string;
  /** 所有状态（key = state name） */
  states: Record<string, StateDef>;
  /** 转移规则（按优先级排列） */
  transitions: TransitionDef[];
  /** 终端状态：进入这些状态后 status 自动变为 'completed' */
  terminalStates?: string[];
  /** 机器完成时的回调（所有步骤结束） */
  onComplete?: (ctx: MachineContext) => void | Promise<void>;
}

/**
 * MachineStatus — 机器生命周期状态。
 *   'idle'     — 未激活
 *   'active'   — 运行中
 *   'completed' — 已到达终端状态
 */
export type MachineStatus = 'idle' | 'active' | 'completed';

/**
 * HistoryEntry — 单次状态转移记录。
 */
export interface HistoryEntry {
  from: string;
  to: string;
  event: string;
}

/**
 * MachineSnapshot — 对外暴露的只读状态视图。
 *
 * bypass agent 通过此快照感知主线状态机状态，
 * 决定是否介入（inject/interrupt/纠偏）。
 */
export interface MachineSnapshot {
  /** 机器 ID */
  machineId: string;
  /** 当前状态名 */
  currentState: string;
  /** 当前状态的人类可读标签 */
  label: string;
  /** 当前状态下可触发的所有事件 */
  availableEvents: string[];
  /** 状态机上下文数据 */
  context: Readonly<MachineContext>;
  /** 生命周期状态 */
  status: MachineStatus;
  /** 当前状态是否为终端状态 */
  isTerminal: boolean;
  /** 最近 20 条转移历史（最近的在末尾） */
  history: ReadonlyArray<HistoryEntry>;
}

/**
 * AdvanceResult — advance() 返回值。
 *
 * ok=false 表示转移被拒绝（guard 不通过或无匹配转移），
 * reason 会通过 complete_flow_step 工具返回值反馈给模型。
 */
export interface AdvanceResult {
  ok: boolean;
  /** 失败原因（guard 不通过时） */
  reason?: string;
  /** 转移到的目标状态 */
  to?: string;
  /** 本次转移后是否到达终端状态 */
  isTerminal?: boolean;
}
