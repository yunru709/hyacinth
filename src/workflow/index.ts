/**
 * ## Workflow 模块 — 统一可扩展工作流系统
 *
 * 设计理念：Plan / Spec / TODO 三者共享 analyze→execute 的框架驱动模式，
 * 通过 WorkflowDefinition 接口泛化为统一体系。所有 Workflow 都是此接口的实例。
 *
 * 扩展一个新 Workflow 的步骤：
 *   1. 在 builtin/ 下新建 xxx.workflow.ts（参考 plan.workflow.ts 的注释模板）
 *   2. 实现 WorkflowDefinition 接口（使用 shared/file-steps.ts 共享工具）
 *   3. 如有引导文本，写成 prompt 模板放入 src/prompts/modes/ 并通过 loadPrompt 加载
 *   4. 在 builtin/index.ts 中导出
 *   5. 在 gateway/factory.ts 中 workflowRegistry.registerBuiltin(createXxxWorkflow())
 *
 * 设计约束：
 *   - 提示词不硬编码在 TS 中 → loadPrompt
 *   - 步骤持久化统一到 ~/.agent/workflows/<name>/<slug>/
 *   - renderPersistent/renderStep 分离，Zone 5 双通道注入
 */

// Workflow module — unified exports
export { WorkflowRegistry } from './registry.js';
export { WorkflowManager } from './manager.js';
export { loadWorkflowFile, scanWorkflowsDir } from './loader.js';
export { createWorkflowTool } from './workflow-tool.js';
export { createConvertSkillToWorkflowTool } from './converter.js';
export { createPlanWorkflow, createSpecWorkflow, createTodoWorkflow, createBootstrapWorkflow } from './builtin/index.js';

export type {
  WorkflowStep,
  WorkflowState,
  WorkflowStepAction,
  WorkflowStepResult,
  WorkflowDefinition,
  WorkflowToolAction,
} from './types.js';
