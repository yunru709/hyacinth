// ============================================================
// Flow Control — 核心类型
// ============================================================
//
// FlowController 是框架级流程控制的抽象。
// 一个 Flow 管理一组有序步骤，在每轮 compose 时注入当前步骤的
// 提示词到 Zone 5，并在检测到步骤完成信号后自动推进。
//
// 同一时间只有一个 Flow 处于活跃状态。
// ============================================================

/** 单个流程步骤 */
export interface FlowStep {
  /** 步骤标识符（全局唯一） */
  id: string;
  /** 注入给模型的提示词文本 */
  prompt: string;
}

/** Flow 状态 */
export type FlowStatus = 'idle' | 'active' | 'completed';

/** Flow 阶段（动态 Flow 使用） */
export type FlowPhase = 'planning' | 'execution';

/**
 * FlowController — 流程控制器接口。
 *
 * 具体实现：
 *   - BootstrapFlow — 固定步骤（预定义 4 步）
 *   - TodoFlow — 动态步骤（模型运行时定义步骤）
 */
export interface FlowController {
  /** 唯一标识，如 'bootstrap'、'todo' */
  readonly id: string;
  /** 当前状态 */
  status: FlowStatus;
  /** 当前步骤索引（0-based） */
  currentStepIndex: number;

  /** 激活 Flow */
  activate(): void;
  /** 停用 Flow */
  deactivate(): void;

  /** 获取所有步骤 */
  getSteps(): FlowStep[];
  /** 获取当前步骤，无则返回 null */
  getCurrentStep(): FlowStep | null;
  /**
   * 推进到下一步。
   * @returns true=还有后续步骤, false=所有步骤已完成
   */
  advance(): boolean;
  /** 是否已完成所有步骤 */
  isComplete(): boolean;
  /**
   * 获取当前注入文本。
   * compose 时由 Zone 5 的 flow_injection section 调用。
   * @returns 当前步骤的提示词，若未激活则返回 null
   */
  getInjection(): string | null;

  /** 完成回调（由 FlowRegistry 在 advance 返回 false 时调用） */
  onComplete?(): Promise<void> | void;
}

/**
 * MutableFlowController — 支持动态步骤的 Flow。
 *
 * 用于 TODO 等场景，模型在运行时通过 add_todo_step 工具添加步骤。
 */
export interface MutableFlowController extends FlowController {
  /** 当前阶段 */
  phase: FlowPhase;

  /**
   * 激活 Flow（带参数）。
   * @param context 激活上下文（如 TODO 的任务描述）
   */
  activate(context?: Record<string, unknown>): void;

  /** 添加一个步骤（仅在 planning 阶段有效） */
  addStep(description: string): FlowStep;

  /** 清空所有步骤 */
  clearSteps(): void;
}

/** FlowRegistry 接口 */
export interface IFlowRegistry {
  register(flow: FlowController): void;
  get(id: string): FlowController | undefined;
  getActive(): FlowController | undefined;
  activate(id: string, context?: Record<string, unknown>): void;
  deactivate(): void;
  /** 当前活跃 Flow 推进一步，若完成则自动 deactivate */
  onStepComplete(): Promise<void>;
}
