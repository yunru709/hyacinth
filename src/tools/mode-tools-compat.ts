/**
 * 向后兼容层 — task_start / task_mark
 *
 * TODO 模式仍然使用 task_mark (通过 handleToolCall)。
 * Plan/Spec 模式建议使用 mode_mark。
 * 当 WorkflowManager 激活时，内部路由到 workflow 工具。
 */

import type { Tool } from './interface.js';
import type { ModeManager } from '../modes/manager.js';
import type { WorkflowManager } from '../workflow/manager.js';

export function createTaskStartTool(modeManager: ModeManager, workflowManager?: WorkflowManager): Tool {
  return {
    name: 'task_start',
    description: 'Start TODO task tracking mode (only available when no Plan/Spec is active).',
    inputSchema: { type: 'object' as const, properties: {} },
    async execute(): Promise<string> {
      // Workflow routing: activate todo workflow
      if (workflowManager?.isActive()) {
        const active = workflowManager.getActive();
        return `当前已有 Workflow "${active}" 激活。使用 workflow({action:"step", ...}) 管理步骤。`;
      }

      if (modeManager.isActive()) {
        const current = modeManager.getActive();
        if (current === 'plan' || current === 'spec') {
          return `当前已有 ${current} 模式激活，无需启动 TODO。直接使用 mode_mark 管理步骤即可。`;
        }
        if (current === 'todo') return 'TODO 模式已激活。';
      }

      // 优先使用 WorkflowManager（如果可用）
      if (workflowManager) {
        try {
          workflowManager.activate('todo', { task: 'manual' });
          return 'TODO 模式已激活。使用 workflow({action:"step", stepAction:"add", description:"..."}) 添加步骤，workflow({action:"step", id:N, stepAction:"done"}) 标记完成。';
        } catch {
          // fall through to old path
        }
      }

      modeManager.activate('todo', { task: 'manual' });
      return 'TODO 模式已激活。使用 task_mark({action:"add", descriptions:[...]}) 添加步骤，task_mark({action:"done", id:N}) 标记完成。';
    },
  };
}

export function createTaskMarkTool(modeManager: ModeManager, workflowManager?: WorkflowManager): Tool {
  return {
    name: 'task_mark',
    description: 'Manage TODO task steps (add/done/blocked/list). Use mode_mark for Plan/Spec modes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string' as const, enum: ['done', 'blocked', 'add', 'note'], description: '操作' },
        id: { type: 'number' as const, description: '步骤编号' },
        description: { type: 'string' as const, description: '步骤描述（add 时使用）' },
        descriptions: { type: 'array' as const, items: { type: 'string' as const }, description: '批量步骤描述' },
        message: { type: 'string' as const, description: '受阻原因' },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      // ── Workflow routing ──────────────────────────────────────────
      if (workflowManager?.isActive()) {
        const action = args.action as string;
        if (action === 'add' && Array.isArray(args.descriptions)) {
          const descs = args.descriptions as string[];
          for (const d of descs) {
            workflowManager.dispatchStep({ action: 'add', description: d });
          }
          return `已添加 ${descs.length} 个步骤。`;
        }

        const result = workflowManager.dispatchStep({
          action: (args.action ?? 'done') as 'done' | 'blocked' | 'add' | 'note',
          id: args.id as number | undefined,
          description: args.description as string | undefined,
          message: args.message as string | undefined,
        });

        if (!result) return '当前 Workflow 不支持此操作。';
        if (result.allDone) {
          workflowManager.deactivate();
          return `✅ ${result.workflow} 全部完成！\n${result.progress}`;
        }
        return `[${result.workflow}] ${result.progress}`;
      }

      // ── Legacy ModeManager path ───────────────────────────────────
      if (!modeManager.isActive()) {
        return '当前没有激活的模式。使用 task_start 启动 TODO 模式。';
      }
      const action = args.action as string;
      const active = modeManager.getActive();

      // Plan/Spec 模式下引导使用 mode_mark
      if (active === 'plan' || active === 'spec') {
        return `当前为 ${active} 模式，请使用 mode_mark 工具而非 task_mark。`;
      }

      // TODO 模式：用 handleToolCall 分发
      if (action === 'add' && Array.isArray(args.descriptions)) {
        const descs = args.descriptions as string[];
        for (const d of descs) {
          modeManager.dispatchToolCall('add', { action: 'add', description: d } as Record<string, unknown>);
        }
        return `已添加 ${descs.length} 个步骤。`;
      }

      const result = modeManager.dispatchToolCall(action, {
        action, id: args.id, description: args.description, message: args.message,
      } as Record<string, unknown>);

      if (!result) return '当前模式不支持此操作。';
      if (result.allDone) {
        modeManager.deactivate();
        return `✅ ${result.mode} 模式全部完成！\n${result.progress}`;
      }
      return `[${result.mode}] ${result.progress}`;
    },
  };
}
