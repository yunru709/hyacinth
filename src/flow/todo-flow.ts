// ============================================================
// TodoFlow — 任务拆分与逐步执行 Flow
// ============================================================
//
// 两阶段动态 Flow：
//   1. Planning — 模型调用 activate_todo 激活 → 注入分析提示词
//      → 模型调用 add_todo_step 添加步骤 → complete_flow_step 完成规划
//   2. Execution — 框架逐步骤注入执行提示词
//      → 模型完成每步后调用 complete_flow_step → 自动推进
// ============================================================

import type { FlowController, FlowStep, FlowStatus, FlowPhase, MutableFlowController } from './types.js';
import { loadPrompt } from '../prompts/loader.js';

export class TodoFlow implements MutableFlowController {
  readonly id = 'todo';
  status: FlowStatus = 'idle';
  currentStepIndex = 0;
  phase: FlowPhase = 'planning';

  private steps: FlowStep[] = [];
  private task: string = '';
  private stepCounter = 0;
  private planningPrompt: string;
  private executionPromptTemplate: string;

  constructor() {
    this.planningPrompt = loadPrompt('flows/todo-planning');
    this.executionPromptTemplate = loadPrompt('flows/todo-execution');
  }

  activate(context?: Record<string, unknown>): void {
    this.task = (context?.task as string) ?? '';
    this.steps = [];
    this.stepCounter = 0;
    this.currentStepIndex = 0;
    this.phase = 'planning';
    this.status = 'active';
  }

  deactivate(): void {
    this.status = 'idle';
    this.steps = [];
    this.task = '';
    this.phase = 'planning';
  }

  getSteps(): FlowStep[] {
    return this.steps;
  }

  getCurrentStep(): FlowStep | null {
    if (this.status !== 'active') return null;
    if (this.phase === 'planning') return null; // 规划阶段没有"当前步骤"
    return this.steps[this.currentStepIndex] ?? null;
  }

  addStep(description: string): FlowStep {
    if (this.phase !== 'planning') {
      throw new Error('Cannot add steps outside planning phase');
    }
    this.stepCounter++;
    const step: FlowStep = {
      id: `todo-step-${this.stepCounter}`,
      prompt: description,
    };
    this.steps.push(step);
    return step;
  }

  clearSteps(): void {
    this.steps = [];
    this.stepCounter = 0;
  }

  advance(): boolean {
    if (this.phase === 'planning') {
      // 规划完成 → 进入执行阶段
      if (this.steps.length === 0) return false; // 没有步骤，直接结束
      this.phase = 'execution';
      this.currentStepIndex = 0;
      return true;
    }

    // 执行阶段：推进到下一步
    this.currentStepIndex++;
    return !this.isComplete();
  }

  isComplete(): boolean {
    if (this.phase === 'planning') return false;
    return this.currentStepIndex >= this.steps.length;
  }

  getInjection(): string | null {
    if (this.status !== 'active') return null;

    if (this.phase === 'planning') {
      return this.buildPlanningInjection();
    }

    // 执行阶段：注入当前步骤
    const step = this.getCurrentStep();
    if (!step) return null;

    return this.buildExecutionInjection(step);
  }

  private buildPlanningInjection(): string {
    return this.planningPrompt.replace(/\{\{task\}\}/g, this.task || '(no task provided)');
  }

  private buildExecutionInjection(step: FlowStep): string {
    return this.executionPromptTemplate
      .replace(/\{\{task\}\}/g, this.task)
      .replace(/\{\{current\}\}/g, String(this.currentStepIndex + 1))
      .replace(/\{\{total\}\}/g, String(this.steps.length))
      .replace(/\{\{description\}\}/g, step.prompt);
  }
}
