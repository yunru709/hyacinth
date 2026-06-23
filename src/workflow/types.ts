/**
 * Workflow System — 统一工作流类型定义
 *
 * 运行时由 WorkflowRegistry 注册、WorkflowManager 管理。
 * 注入架构（Zone 5）：
 *   renderPersistent → workflow_persistent（阶段引导/分析，阶段切换时变化）
 *   renderStep      → workflow_step（当前步骤指令，每步变化）
 *
 * ## handleStep 约定
 *
 * 所有 handleStep 必须处理以下 actions（即使只返回 null）：
 *   - done / blocked  → 步骤推进（执行阶段）
 *   - add             → 追加步骤
 *   - note / progress → 记录信息（不改变步骤状态）
 *   - complete        → 阶段切换或全局完成标记
 *
 * 返回值：
 *   - { newState, result } → 正常处理
 *   - null                 → 不支持该操作（框架返回 "not supported"）
 */

// ─── 步骤 ─────────────────────────────────────────────────────────────

export interface WorkflowStep {
  /** 步骤编号（1-based） */
  id: number;
  /** 步骤名称（展示用，可含段落前缀如 "[第一部分] 描述"） */
  name: string;
  /** 步骤描述 */
  description: string;
  /** 当前状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  /** 依赖步骤 ID（保留字段） */
  dependsOn?: number[];
  /** 阻塞原因（status === 'blocked' 时） */
  reason?: string;
}

// ─── 运行时状态 ───────────────────────────────────────────────────────

export interface WorkflowState {
  /** 工作流名称 */
  name: string;
  /** 当前阶段（由具体 Workflow 实现定义其枚举值） */
  phase?: string;
  /** 工作流特定数据（由具体 Workflow 实现定义其结构） */
  data: Record<string, unknown>;
  /** 步骤列表（与 handleStep 同步维护） */
  steps: WorkflowStep[];
  /** 激活时间（ISO 字符串） */
  startedAt?: string;
}

// ─── 步骤操作参数 ─────────────────────────────────────────────────────

export interface WorkflowStepAction {
  /** 操作类型 */
  action: 'done' | 'blocked' | 'add' | 'note' | 'progress' | 'complete';
  /** 步骤编号（1-based）。add/note/progress 时可选，done/blocked 时必填 */
  id?: number;
  /** 步骤描述（add 时使用） */
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
  /** 进度描述（人类可读，含 emoji） */
  progress: string;
  /** 是否全部完成。true 时框架自动调用 manager.deactivate() */
  allDone: boolean;
  /** 下一步建议（框架展示给模型） */
  nextStep?: WorkflowStep;
}

// ─── 工作流定义 ───────────────────────────────────────────────────────

export interface WorkflowDefinition {
  /** 唯一名称（注册表键）。内置名受保护，不可被文件 Workflow 覆盖 */
  name: string;
  /** 简短描述（用于 /workflows 列表和 Zone 2 manifest） */
  description: string;
  /** 来源 */
  source: 'builtin' | 'file' | 'plugin' | 'converted';
  /** 关联工具白名单（soft 提示） */
  relatedTools?: string[];
  /** 触发关键词（LLM 匹配建议） */
  triggerKeywords?: string[];

  /**
   * 创建初始状态。
   * 不应写模板文件——文件由模型按注入的引导模板自行创建。
   * 若检测到已有步骤文件（如 plan.md），可直接进入 execute 阶段。
   */
  createState: (params: Record<string, unknown>) => WorkflowState;

  /**
   * 处理步骤操作。
   * 返回 null 表示不支持该操作（框架返回错误提示）。
   * 返回 { newState, result } 更新状态并推进。
   *
   * 推荐实现模式（参考 builtin/plan.workflow.ts）：
   *   switch (action.action) {
   *     case 'complete': → 阶段切换或全局标记
   *     case 'progress': case 'note': → 透传消息，不改变步骤状态
   *     case 'add':      → 追加步骤
   *     case 'done': case 'blocked': → 标记步骤 + 自动推进
   *   }
   */
  handleStep?: (
    state: WorkflowState,
    action: WorkflowStepAction,
  ) => { newState: WorkflowState; result: WorkflowStepResult } | null;

  /**
   * 兼容旧接口——若不实现 renderPersistent/renderStep 则回退到此。
   * 新 Workflow 应优先实现下面两个方法。
   */
  renderForInjection: (state: WorkflowState) => string;

  /**
   * 持久上下文注入 → Zone 5 workflow_persistent。
   * 阶段引导提示词、分析结果、spec.md 内容等不随步骤变化的内容。
   * 阶段切换时内容才变化（analyze→execute），同阶段内多轮不变。
   */
  renderPersistent?: (state: WorkflowState) => string;

  /**
   * 当前步骤注入 → Zone 5 workflow_step。
   * 单条步骤指令，每步变化。非执行阶段返回空字符串。
   * 只展示当前一步，不展示全量步骤列表。
   */
  renderStep?: (state: WorkflowState) => string;

  /**
   * 判断工作流是否已完成。
   * 内置 Workflow 通常在 execute 阶段检查所有步骤 done。
   * 若返回 true，checkComplete() 会调用 deactivate()。
   */
  isComplete: (state: WorkflowState) => boolean;

  /** 停用时的清理回调（如清理临时文件） */
  onDeactivate?: (state: WorkflowState) => void;
}

// ─── workflow 工具 action 类型 ──────────────────────────────────────

export type WorkflowToolAction = 'list' | 'activate' | 'step';
