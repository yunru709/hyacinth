/**
 * plan-execute/executor.ts —— 预测式批量执行器（纯机械，零 LLM）。
 *
 * executePlan(plan, runCommand)：
 *  - 逐 Step 执行命令组（串行/并行）→ 收集结果 → 断言评估；
 *  - 预测命中 → 记录完成，自动推进下一步；
 *  - 预测落空 → 立即返回结构化失败报告（onMiss: handoff，交回主循环）。
 *
 * 纯逻辑：runCommand（执行单条工具调用）由调用方注入（工具层接 ToolExecutor），
 * 本模块不依赖运行时，可独立测试。
 */
import type { Plan, CommandCall, CommandResult, PlanStep } from './types.js';
import { evaluatePrediction, type AssertionVerdict } from './assertions.js';

/** 单条工具调用的执行函数（由注入方提供） */
export type RunCommand = (call: CommandCall) => Promise<CommandResult>;

/** 一步的执行产出 */
export interface StepRecord {
  stepIndex: number;
  commands: CommandCall[];
  results: CommandResult[];
  predictionVerdict: AssertionVerdict;
}

export type PlanExecutionResult =
  /** 全部步骤预测命中 → 完成 */
  | { status: 'done'; steps: StepRecord[] }
  /** 某步预测落空 → 交回主循环（附完整失败上下文） */
  | {
      status: 'handoff';
      plan: Plan;
      stepIndex: number;
      failedStep: PlanStep;
      completed: StepRecord[];
      prediction: unknown;
      actual: CommandResult[];
      reason: string;
    };

/** 跑一个 Step 的命令组（串行 / 并行），返回结果 */
async function runStepCommands(step: PlanStep, run: RunCommand): Promise<CommandResult[]> {
  if (step.parallel) {
    return Promise.all(step.commands.map((call) => run(call)));
  }
  const out: CommandResult[] = [];
  for (const call of step.commands) {
    out.push(await run(call));
  }
  return out;
}

/** 执行预测式计划 */
export async function executePlan(plan: Plan, run: RunCommand): Promise<PlanExecutionResult> {
  const completed: StepRecord[] = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const results = await runStepCommands(step, run);
    const verdict = evaluatePrediction(step.prediction, results);

    const record: StepRecord = { stepIndex: i, commands: step.commands, results, predictionVerdict: verdict };
    if (verdict.ok) {
      completed.push(record);
      continue;
    }
    // 预测落空 → handoff（交回主循环），附完整失败上下文
    return {
      status: 'handoff',
      plan,
      stepIndex: i,
      failedStep: step,
      completed,
      prediction: step.prediction,
      actual: results,
      reason: verdict.reason ?? 'prediction 未命中',
    };
  }

  return { status: 'done', steps: completed };
}
