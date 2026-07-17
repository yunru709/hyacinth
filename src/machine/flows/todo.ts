// ============================================================
// TodoFlow — 任务拆分与逐步执行 Flow
// ============================================================
//
// 基于 MachineDef 的两阶段动态 Flow：
//   1. Planning — 模型调用 flow_add 添加步骤（ctx 突变）
//      → flow_complete（guard: steps.length > 0）进入执行阶段
//   2. Executing — 模型逐步完成每步
//      → flow_complete（guard: hasMoreSteps）推进 stepIndex
//      → flow_complete（guard: isLastStep）进入终端
//
// 关键设计：
//   - flow_add 是 context 突变，不触发状态转移（绕过 guard）
//   - flow_complete 是事件，触发 guard → 转移
//   - Guard 失败时 reason 通过工具返回值反馈给模型
// ============================================================

import type { MachineContext, MachineDef, MachineSnapshot, AdvanceResult } from '../types.js';
import { MachineRunner } from '../runner.js';
import type { FlowController } from './types.js';
import { loadPrompt } from '../../prompts/loader.js';

// ── 步骤类型 ────────────────────────────────────────────────

interface TodoStep {
  id: string;
  label: string;
}

// ── MachineDef ──────────────────────────────────────────────

/**
 * TODO 状态机定义。
 *
 * States:  planning | executing | __completed__
 * Initial: planning
 * Terminal: __completed__
 *
 * 转移表（按优先级排列——先匹配的 guard 通过即执行）：
 *   1. planning   + complete → executing     (guard: steps.length > 0)
 *   2. planning   + complete → __completed__  (guard: steps.length === 0)
 *   3. executing  + complete → executing     (guard: hasMoreSteps, onTransition: stepIndex++)
 *   4. executing  + complete → __completed__  (guard: isLastStep)
 */
function createTodoMachineDef(): MachineDef {
  return {
    id: 'todo',
    initial: 'planning',
    states: {
      planning:     { label: '规划中' },
      executing:    { label: '执行中' },
      __completed__: { label: '已完成' },
    },
    transitions: [
      // planning → executing：必须有步骤
      {
        from: 'planning',
        to: 'executing',
        event: 'flow_complete',
        guard: (ctx: MachineContext) => {
          const steps = (ctx.steps as TodoStep[] | undefined) ?? [];
          if (steps.length === 0) {
            return { ok: false, reason: 'No steps defined. Use flow_add to add steps before completing planning.' };
          }
          return { ok: true };
        },
        onTransition: (ctx: MachineContext) => {
          // 重置 stepIndex 到第 0 步
          ctx.stepIndex = 0;
        },
      },
      // planning → __completed__：没有步骤直接结束
      {
        from: 'planning',
        to: '__completed__',
        event: 'flow_complete',
        guard: (ctx: MachineContext) => {
          const steps = (ctx.steps as TodoStep[] | undefined) ?? [];
          return { ok: steps.length === 0 };
        },
      },
      // executing → executing：还有更多步骤（self-transition）
      {
        from: 'executing',
        to: 'executing',
        event: 'flow_complete',
        guard: (ctx: MachineContext) => {
          const steps = (ctx.steps as TodoStep[] | undefined) ?? [];
          const idx = (ctx.stepIndex as number) ?? 0;
          if (idx + 1 >= steps.length) {
            return { ok: false, reason: 'This is the last step.' };
          }
          return { ok: true };
        },
        onTransition: (ctx: MachineContext) => {
          ctx.stepIndex = ((ctx.stepIndex as number) ?? 0) + 1;
        },
      },
      // executing → __completed__：最后一步完成
      {
        from: 'executing',
        to: '__completed__',
        event: 'flow_complete',
        guard: (ctx: MachineContext) => {
          const steps = (ctx.steps as TodoStep[] | undefined) ?? [];
          const idx = (ctx.stepIndex as number) ?? 0;
          return { ok: idx + 1 >= steps.length };
        },
      },
    ],
    terminalStates: ['__completed__'],
  };
}

// ── TodoFlow ─────────────────────────────────────────────────

export class TodoFlow implements FlowController {
  readonly id = 'todo';
  readonly runner: MachineRunner;

  private planningPrompt: string;
  private executionPromptTemplate: string;
  private stepCounter = 0;

  constructor() {
    this.planningPrompt = loadPrompt('flows/todo-planning');
    this.executionPromptTemplate = loadPrompt('flows/todo-execution');
    this.runner = new MachineRunner(createTodoMachineDef());
  }

  // ── 生命周期 ──────────────────────────────────────────────

  activate(context?: MachineContext): void {
    this.stepCounter = 0;
    this.runner.activate({
      task: context?.task ?? '',
      steps: [] as TodoStep[],
      stepIndex: 0,
    });
  }

  deactivate(): void {
    this.runner.deactivate();
  }

  advance(event: string): AdvanceResult {
    return this.runner.advance(event);
  }

  getSnapshot(): MachineSnapshot {
    return this.runner.getSnapshot();
  }

  isComplete(): boolean {
    return this.runner.isComplete();
  }

  // ── 业务方法 ──────────────────────────────────────────────

  /** 向 TODO 计划添加一个执行步骤（仅在 planning 阶段有效） */
  addItem(description: string): TodoStep {
    const snap = this.runner.getSnapshot();
    if (snap.currentState !== 'planning') {
      throw new Error('Cannot add steps outside planning phase');
    }

    this.stepCounter++;
    const step: TodoStep = {
      id: `todo-step-${this.stepCounter}`,
      label: description,
    };

    const steps = [...((snap.context.steps as TodoStep[]) ?? []), step];
    this.runner.updateContext({ steps });

    return step;
  }

  /** Zone 5 注入文本 */
  getInjection(): string | null {
    const snap = this.runner.getSnapshot();
    if (snap.status !== 'active') return null;

    if (snap.currentState === 'planning') {
      return this.planningPrompt
        .replace(/\{\{task\}\}/g, (snap.context.task as string) || '(no task provided)');
    }

    if (snap.currentState === 'executing') {
      const steps = (snap.context.steps as TodoStep[] | undefined) ?? [];
      const idx = (snap.context.stepIndex as number) ?? 0;
      const step = steps[idx];
      if (!step) return null;

      return this.executionPromptTemplate
        .replace(/\{\{task\}\}/g, (snap.context.task as string) || '')
        .replace(/\{\{current\}\}/g, String(idx + 1))
        .replace(/\{\{total\}\}/g, String(steps.length))
        .replace(/\{\{description\}\}/g, step.label);
    }

    return null;
  }
}
