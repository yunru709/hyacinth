/**
 * Workflow Tool — 统一的工作流驱动工具
 *
 * 一个工具，三种 action，覆盖发现→激活→执行的完整生命周期：
 *   list     — 发现可用 Workflow
 *   activate — 激活指定 Workflow
 *   step     — 在当前 Workflow 中推进步骤
 *
 * 参考 use_skill 的"一个工具 + 参数选择目标"模式。
 */

import type { Tool } from '../tools/interface.js';
import type { WorkflowRegistry } from './registry.js';
import type { WorkflowManager } from './manager.js';

export function createWorkflowTool(
  registry: WorkflowRegistry,
  manager: WorkflowManager,
): Tool {
  return {
    name: 'workflow',
    description:
      'Discover, activate, and step through structured workflows. ' +
      'Use action "list" to see available workflows, "activate" to start one, ' +
      '"step" to mark steps done/blocked or add new steps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string' as const,
          enum: ['list', 'activate', 'step'],
          description: 'list: discover available workflows | activate: start a workflow | step: advance steps in active workflow',
        },
        name: {
          type: 'string' as const,
          description: 'Workflow name (required for activate). Use names from the list action.',
        },
        // step params (mirrors task_mark params)
        id: {
          type: 'number' as const,
          description: 'Step number (1-based). For Spec Phase 1→2 transition, use id:0.',
        },
        stepAction: {
          type: 'string' as const,
          enum: ['done', 'blocked', 'add', 'note', 'progress', 'complete'],
          description: 'Step operation: done (mark complete), blocked (mark blocked), add (append new step), note (no state change), progress (record progress), complete (finish bootstrap)',
        },
        description: {
          type: 'string' as const,
          description: 'Step description text (for add operation)',
        },
        message: {
          type: 'string' as const,
          description: 'Blocked reason or free-form note text',
        },
      },
      required: ['action'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const action = args.action as string;

      switch (action) {
        // ── list ───────────────────────────────────────────────────────
        case 'list': {
          const index = registry.getIndex();
          if (!index) return 'No workflows registered. Built-in workflows (plan, spec, todo) should always be available.';
          return index;
        }

        // ── activate ───────────────────────────────────────────────────
        case 'activate': {
          const name = args.name as string;
          if (!name) {
            const available = registry.getAll().map(w => w.name).join(', ');
            return `Error: "name" is required for activate. Available workflows: [${available}]`;
          }

          try {
            manager.activate(name, args);
            const injection = manager.renderForInjection();
            return `Workflow "${name}" activated.\n\n${injection ?? ''}`;
          } catch (err) {
            const available = registry.getAll().map(w => w.name).join(', ');
            return `Error activating "${name}": ${(err as Error).message}\nAvailable workflows: [${available}]`;
          }
        }

        // ── step ───────────────────────────────────────────────────────
        case 'step': {
          if (!manager.isActive()) {
            return 'No active workflow. Use workflow({action:"list"}) to see available workflows, then workflow({action:"activate", name:"..."}) to start one.';
          }

          const stepAction = (args.stepAction as string) || 'done';
          const result = manager.dispatchStep({
            action: stepAction as 'done' | 'blocked' | 'add' | 'note' | 'progress' | 'complete',
            id: args.id as number | undefined,
            description: args.description as string | undefined,
            message: args.message as string | undefined,
          });

          if (!result) {
            return `Step action "${stepAction}" is not supported by the current workflow. Supported actions: done, blocked, add, note.`;
          }

          if (result.allDone) {
            manager.deactivate();
            return `${result.progress}\n\nAll steps complete. Workflow "${result.workflow}" finished.`;
          }

          const nextHint = result.nextStep
            ? `\nNext step: ${result.nextStep.id}. ${result.nextStep.description}`
            : '';

          return `${result.progress}${nextHint}`;
        }

        default:
          return `Unknown action: "${action}". Supported actions: list, activate, step.`;
      }
    },
  };
}
