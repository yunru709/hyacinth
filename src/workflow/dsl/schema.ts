/**
 * ## DSL IR 类型定义 — 声明式工作流的中间表示
 *
 * 这些类型定义了 YAML 解析后的中间表示（IR）。
 * compiler.ts 消费这些类型，产出标准 WorkflowDefinition。
 *
 * 设计约束：
 *   - 所有字段对应 YAML schema 中的声明式字段
 *   - 不包含任何可执行代码（纯数据）
 *   - 可在 GUI 中序列化/反序列化
 *
 * ## 扩展 IR
 *
 * 新增原语能力时：
 *   1. 在此文件中添加新的 IR 类型
 *   2. 在 parser.ts 中添加对应的 YAML→IR 转换
 *   3. 在 compiler.ts 中添加对应的 IR→闭包 编译逻辑
 *   4. 确保 schema version 递增
 */

// ─── 变量定义 ────────────────────────────────────────────────────────────

/** 静态变量：createState 时求值一次 */
export type StaticVarDef =
  | { compute: 'slug'; from: string; maxLen?: number; fallback?: string }
  | { compute: 'path'; segments: string[]; mkdir?: boolean }
  | { compute: 'literal'; value: unknown };

/** 动态变量表达式：render 时从 state 重新求值 */
export type DynamicVarExpr =
  | { source: 'data'; field: string; transform?: 'join' | 'count'; fallback?: string }
  | { source: 'file'; path: string; onMissing?: 'empty' | 'error' }
  | { source: 'steps'; stat: 'done' | 'blocked' | 'remaining' | 'total' };

// ─── 状态初始化 ──────────────────────────────────────────────────────────

export interface DataFieldDef {
  type: 'string' | 'array' | 'boolean' | 'number';
  default?: unknown;
}

export interface WorkDirDef {
  base: string;
  segments: string[];
}

export interface InitIR {
  staticVars: Record<string, StaticVarDef>;
  dynamicVars: Record<string, DynamicVarExpr>;
  data: Record<string, DataFieldDef>;
  taskFrom?: string;
  workDir?: WorkDirDef;
  phaseField: 'state' | 'data' | 'both';
}

// ─── 阶段定义 ────────────────────────────────────────────────────────────

export interface SkipIfDef {
  file: string;
  condition: 'exists' | 'non-empty' | 'has-checkboxes';
  thenPhase: string;
}

export type StepSourceDef =
  | { type: 'file'; path: string; format: 'flat' | 'sectioned' }
  | { type: 'memory'; field: string }
  | { type: 'none' };

export interface ActionDoneDef {
  source: 'file' | 'memory';
  markFile?: 'x';
  setStatus?: 'completed';
  autoAdvance?: boolean;
}

export interface ActionBlockedDef {
  source: 'file' | 'memory';
  markFile?: 'blocked';
  setStatus?: 'blocked';
  autoAdvance?: boolean;
}

export interface ActionAddDef {
  source: 'file' | 'memory';
  appendToFile?: boolean;
  pushToMemory?: boolean;
}

export interface ActionNoteProgressDef {
  appendToData?: string;
  appendToDataArray?: string;
}

export interface ValidateDef {
  type: 'file' | 'data';
  path?: string;
  field?: string;
  condition: 'exists' | 'non-empty' | 'has-checkboxes' | 'all-done';
  message: string;
}

export interface ActionCompleteDef {
  transition: string | null;  // null = stay in phase
  validate?: ValidateDef[];
  hook?: string;              // hook name
}

export interface ActionDefsIR {
  done?: ActionDoneDef;
  blocked?: ActionBlockedDef;
  add?: ActionAddDef;
  note?: ActionNoteProgressDef;
  progress?: ActionNoteProgressDef;
  complete?: ActionCompleteDef;
}

export interface AutoTransitionDef {
  when: 'all-steps-done';
  toPhase: string | null;  // null = workflow complete
}

// ─── 渲染配置 ─────────────────────────────────────────────────────────────

export type RenderPersistentDef =
  | { type: 'template'; template: string; staticVars?: Record<string, string>; dynamicVars?: Record<string, string> }
  | { type: 'progress-summary'; title: string; file?: string; fromMemory?: boolean }
  | { type: 'file-content'; file: string; onMissing?: 'empty' | 'error' }
  | { type: 'data-content'; field: string; transform?: 'join'; fallback?: string; prefix?: string }
  | { type: 'composite'; sections: RenderPersistentDef[] }
  | { type: 'none' };

export type RenderStepDef =
  | { type: 'current-step'; stepLabel: string; showWorkflowCommand?: boolean }
  | { type: 'next-step'; stepLabel: string; showWorkflowCommand?: boolean }
  | { type: 'none' };

export interface RenderDef {
  persistent: RenderPersistentDef;
  step: RenderStepDef;
}

// ─── 阶段 ─────────────────────────────────────────────────────────────────

export interface PhaseIR {
  name: string;
  description?: string;
  skipIf?: SkipIfDef;
  stepSource: StepSourceDef;
  stepNameTemplate?: string;   // default: "[{section}] {text}"
  actions: string[];
  onAction: ActionDefsIR;
  autoTransition?: AutoTransitionDef;
  render: RenderDef;
}

// ─── 完成条件 ─────────────────────────────────────────────────────────────

export type CompleteIR =
  | { condition: 'all-steps-done'; file?: string }
  | { condition: 'phase-and-all-done'; phase: string; file?: string }
  | { condition: 'flag'; flag: string };

// ─── Hook ─────────────────────────────────────────────────────────────────

export interface HookDef {
  module: string;
  export: string;
}

// ─── 顶层 IR ──────────────────────────────────────────────────────────────

export interface WorkflowIR {
  schema: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  relatedTools: string[];
  init: InitIR;
  phases: PhaseIR[];
  complete: CompleteIR;
  hooks?: Record<string, HookDef>;
  onDeactivate: string;
}

// ─── 兼容：旧简单 YAML 格式 ───────────────────────────────────────────────

/** 旧 loader.ts 支持的简单步骤定义 */
export interface LegacySimpleStep {
  id: number;
  name: string;
  description: string;
}

/** 旧 loader.ts 支持的简单 YAML */
export interface LegacyWorkflowRaw {
  name?: string;
  description?: string;
  triggerKeywords?: string[];
  relatedTools?: string[];
  steps?: LegacySimpleStep[];
}
