// ============================================================
// Flow Tools — 流程控制工具
// ============================================================
//
// complete_flow_step  — 完成当前步骤，推进到下一步（所有 Flow 通用）
// activate_todo       — 激活 TODO 模式，开始任务拆分
// add_todo_step       — 向 TODO Flow 添加执行步骤（仅 planning 阶段）
// ============================================================

import type { Tool } from '../tools/interface.js';
import type { FlowRegistry } from './flow-registry.js';
import type { MutableFlowController } from './types.js';

/** Flow 框架工具名称集合 — 这些工具不记入对话历史 */
const FLOW_TOOL_NAMES = new Set([
  'complete_flow_step',
  'activate_todo',
  'add_todo_step',
]);

/** 判断给定工具名是否为 Flow 框架工具 */
export function isFlowTool(name: string): boolean {
  return FLOW_TOOL_NAMES.has(name);
}

export function createCompleteFlowStepTool(registry: FlowRegistry): Tool {
  return {
    name: 'complete_flow_step',
    description:
      'Complete the current flow step and advance to the next one. Call this when you have finished the current step\'s task. In TODO planning phase, this finishes planning and starts execution. In execution phase or bootstrap, this advances to the next step. If this is the final step, the flow ends.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_args: Record<string, unknown>): Promise<string> {
      const active = registry.getActive();
      if (!active) {
        return 'No active flow. Nothing to complete.';
      }

      // NOTE: 此处不调用 advance()。advance 统一由 loop.ts → onStepComplete()
      // 在工具执行后调用（见 flow-registry.ts）。两边都调会导致每步跳两步。
      const mutableFlow = active as MutableFlowController;
      const isTodoPlanning = active.id === 'todo' && mutableFlow.phase === 'planning';

      const currentStep = active.getCurrentStep();
      const stepLabel = currentStep
        ? `"${currentStep.id}" (step ${active.currentStepIndex + 1}/${active.getSteps().length})`
        : isTodoPlanning
          ? `planning phase`
          : `step ${active.currentStepIndex + 1}`;

      if (isTodoPlanning) {
        const stepCount = active.getSteps().length;
        return `Planning acknowledged. ${stepCount > 0 ? `${stepCount} steps defined, transitioning to execution.` : 'No steps defined — flow will end.'}`;
      }

      return `Step ${stepLabel} acknowledged. Advancing...`;
    },
  };
}

export function createActivateTodoTool(registry: FlowRegistry): Tool {
  return {
    name: 'activate_todo',
    description:
      'Activate TODO mode to break down a complex task into ordered steps. After activation, use add_todo_step to add each step, then call complete_flow_step to start execution. The framework will guide you through one step at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'A concise description of the overall task to be completed.',
        },
      },
      required: ['task'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const task = (args.task as string) ?? '';

      const todoFlow = registry.get('todo');
      if (!todoFlow) {
        return 'TODO flow is not registered. Cannot activate.';
      }

      // 激活 TODO Flow（带任务上下文），自动停用当前活跃 Flow
      registry.activate('todo', { task });

      return `TODO mode activated for task: "${task}". Break down the task into steps using add_todo_step, then call complete_flow_step to start execution.`;
    },
  };
}

export function createAddTodoStepTool(registry: FlowRegistry): Tool {
  return {
    name: 'add_todo_step',
    description:
      'Add a step to the current TODO flow. Only works when TODO mode is active and in the planning phase. Each step should be a concrete, verifiable action.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A clear, actionable description of this step. Include what constitutes success.',
        },
      },
      required: ['description'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const active = registry.getActive();
      if (!active || active.id !== 'todo') {
        return 'TODO mode is not active. Use activate_todo first.';
      }

      const mutableFlow = active as MutableFlowController;
      if (mutableFlow.phase !== 'planning') {
        return 'Cannot add steps — TODO is already in execution phase.';
      }

      const description = (args.description as string) ?? '';
      const step = mutableFlow.addStep(description);

      return `Step #${mutableFlow.getSteps().length} added: "${step.prompt}". Total: ${mutableFlow.getSteps().length} steps. Add more steps or call complete_flow_step to start execution.`;
    },
  };
}
