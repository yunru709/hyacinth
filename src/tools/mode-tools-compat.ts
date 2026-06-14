/**
 * 向后兼容层 — task_start / task_mark
 *
 * TODO 模式仍然使用 task_mark (通过 handleToolCall)。
 * Plan/Spec 模式建议使用 mode_mark。
 */

import type { Tool } from './interface.js';
import type { ModeManager } from '../modes/manager.js';

export function createTaskStartTool(modeManager: ModeManager): Tool {
  return {
    name: 'task_start',
    description: '启动 TODO 任务跟踪模式（仅当没有 Plan/Spec 激活时可用）。',
    inputSchema: { type: 'object' as const, properties: {} },
    async execute(): Promise<string> {
      if (modeManager.isActive()) {
        const current = modeManager.getActive();
        if (current === 'plan' || current === 'spec') {
          return `当前已有 ${current} 模式激活，无需启动 TODO。直接使用 mode_mark 管理步骤即可。`;
        }
        if (current === 'todo') return 'TODO 模式已激活。';
      }
      modeManager.activate('todo', { task: 'manual' });
      return 'TODO 模式已激活。使用 task_mark({action:"add", descriptions:[...]}) 添加步骤，task_mark({action:"done", id:N}) 标记完成。';
    },
  };
}

export function createTaskMarkTool(modeManager: ModeManager): Tool {
  return {
    name: 'task_mark',
    description: 'TODO 模式步骤管理（Plan/Spec 请使用 mode_mark）。',
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
