/**
 * plan-execute/index.ts —— 预测式批量执行（工具 + 断言 + 执行器）。
 */
export { createPlanExecuteTool } from './tool.js';
export { executePlan } from './executor.js';
export type { PlanExecutionResult, RunCommand, StepRecord } from './executor.js';
export { evaluatePrediction } from './assertions.js';
export type { AssertionVerdict } from './assertions.js';
export type {
  Plan, PlanStep, CommandCall, CommandResult, Prediction, AssertionPrimitive,
} from './types.js';
