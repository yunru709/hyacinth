/**
 * Workflow System — 统一工作流类型定义
 *
 * Workflow 是 Plan / Spec / TODO / (转换后的)Skill 的统一容器。
 * 由 WorkflowRegistry 注册、WorkflowManager 管理运行时状态。
 *
 * 激活方式：/workflow <name> 或 workflow({action:"activate", name})
 * 步骤推进：workflow({action:"step", id:N, stepAction:"done"})
 * 注入：renderForInjection() → Zone 5 workflow-injection
 */

// ─── 步骤 ─────────────────────────────────────────────────────────────

export interface WorkflowStep {
  /** 步骤编号（1-based，与现有 task_mark id 语义一致） */
  id: number;
  /** 步骤名称 */
  name: string;
  /** 步骤描述 */
  description: string;
  /** 当前状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  /** 依赖步骤 ID（保留字段，第一版只校验不执行拓扑排序） */
  dependsOn?: number[];
  /** 阻塞原因（status === 'blocked' 时） */
  reason?: string;
}

// ─── 运行时状态 ───────────────────────────────────────────────────────

export interface WorkflowState {
  /** 工作流名称 */
  name: string;
  /** 当前阶段（Spec 为 "spec"|"tasks"|"checklist"，其他为 undefined） */
  phase?: string;
  /** 工作流特定数据（planDir / specDir 等） */
  data: Record<string, unknown>;
  /** 步骤列表 */
  steps: WorkflowStep[];
  /** 激活时间 */
  startedAt?: string;
}

// ─── 步骤操作参数 ─────────────────────────────────────────────────────

export interface WorkflowStepAction {
  /** 操作类型（与现有 task_mark action 一致） */
  action: 'done' | 'blocked' | 'add' | 'note' | 'progress' | 'complete';
  /** 步骤编号（1-based） */
  id?: number;
  /** 步骤描述（add 操作时使用） */
  description?: string;
  /** 附加消息（blocked 原因 / note 内容 / progress 更新） */
  message?: string;
}

// ─── 步骤操作结果 ─────────────────────────────────────────────────────

export interface WorkflowStepResult {
  /** 工作流名称 */
  workflow: string;
  /** 当前阶段 */
  phase?: string;
  /** 进度汇总（人类可读，含 emoji 标记） */
  progress: string;
  /** 是否全部完成 */
  allDone: boolean;
  /** 下一步建议 */
  nextStep?: WorkflowStep;
}

// ─── 工作流定义 ───────────────────────────────────────────────────────

export interface WorkflowDefinition {
  /** 唯一名称（注册表键） */
  name: string;
  /** 简短描述（用于索引显示） */
  description: string;
  /** 来源：内置 / 文件加载 / 插件 / Skill 转换 */
  source: 'builtin' | 'file' | 'plugin' | 'converted';
  /** 关联工具白名单（soft 提示，默认不强制） */
  relatedTools?: string[];
  /** 触发关键词（LLM 匹配建议，可选） */
  triggerKeywords?: string[];

  /** 创建初始状态 */
  createState: (params: Record<string, unknown>) => WorkflowState;

  /**
   * 处理步骤操作，返回 { newState, result }。
   * 若操作与当前工作流无关，返回 null。
   * 若不实现（undefined），表示该工作流不接受步骤操作（纯展示型）。
   */
  handleStep?: (
    state: WorkflowState,
    action: WorkflowStepAction,
  ) => { newState: WorkflowState; result: WorkflowStepResult } | null;

  /** 渲染注入到对话中的提示词内容 */
  renderForInjection: (state: WorkflowState) => string;

  /** 判断工作流是否已完成 */
  isComplete: (state: WorkflowState) => boolean;

  /** 停用时的清理回调 */
  onDeactivate?: (state: WorkflowState) => void;
}

// ─── workflow 工具 action 类型 ──────────────────────────────────────

export type WorkflowToolAction = 'list' | 'activate' | 'step';
