/**
 * Mode System — 模式系统核心类型定义（v2: 工具驱动）。
 *
 * 激活方式：/plan、/spec、task_start（TODO 模式）→ ModeManager.activate()
 * 状态同步：LLM 调用 task_mark 工具 → ModeManager.dispatchToolCall() → 更新状态 → 返回进度
 * 注入：renderForInjection() → Zone 5 mode_injection section
 */

// ─── 模式状态 ───────────────────────────────────────────────────────

export interface ModeState {
  name: string;
  data: Record<string, unknown>;
}

// ─── 工具调用参数 ───────────────────────────────────────────────────

export interface TaskMarkParams {
  action: 'done' | 'blocked' | 'add' | 'note' | 'progress' | 'complete';
  id?: number;
  description?: string;
  message?: string;
}

export interface TaskMarkResult {
  /** 模式名 */
  mode: string;
  /** 当前阶段（Plan 为 "exec", Spec 为 "spec"|"tasks"|"checklist"） */
  phase?: string;
  /** 步骤/任务的进度汇总 */
  progress: string;
  /** 是否全部完成 */
  allDone: boolean;
}

// ─── 模式定义 ───────────────────────────────────────────────────────

export interface ModeDefinition {
  name: string;

  /** 创建初始状态 */
  createState: (params: Record<string, unknown>) => ModeState;

  /**
   * 处理工具调用，返回 { newState, result }。
   * 若工具调用与当前模式无关，返回 null（由其他模式处理）。
   */
  handleToolCall?: (
    state: ModeState,
    action: string,
    params: TaskMarkParams,
  ) => { newState: ModeState; result: TaskMarkResult } | null;

  /** 渲染注入到对话中的提示词内容 */
  renderForInjection: (state: ModeState) => string;

  /** 判断模式是否已完成 */
  isComplete: (state: ModeState) => boolean;

  /** 停用时的清理回调 */
  onDeactivate?: (state: ModeState) => void;
}
