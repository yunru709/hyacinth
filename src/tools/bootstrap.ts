import type { Tool } from './interface.js';
import type { ModeManager } from '../modes/manager.js';

export function createBootstrapMarkTool(modeManager: ModeManager): Tool {
  return {
    name: 'bootstrap_mark',
    description: 'Mark bootstrap progress. Use "progress" to record info, "complete" to finish and exit bootstrap mode.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['progress', 'complete'],
          description: '操作类型',
        },
        message: {
          type: 'string',
          description: 'progress 时记录已收集的信息',
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      if (!modeManager.isActive() || modeManager.getActive() !== 'bootstrap') {
        return '当前没有激活 bootstrap 模式。';
      }

      const action = String(args.action ?? '');
      if (action !== 'progress' && action !== 'complete') {
        return 'Error: action must be "progress" or "complete".';
      }

      const result = modeManager.dispatchToolCall(action, {
        action,
        message: typeof args.message === 'string' ? args.message : undefined,
      });

      if (!result) {
        return '当前 bootstrap 模式不支持此操作。';
      }

      if (result.allDone) {
        modeManager.deactivate();
        return `✅ ${result.mode} 模式全部完成！\n${result.progress}\n\n模式已自动停用。`;
      }

      return `[${result.mode}] ${result.progress}`;
    },
  };
}
