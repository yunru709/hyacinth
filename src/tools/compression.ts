/**
 * trigger_compression — 手动触发上下文压缩
 */
import type { Tool } from './interface.js';
import type { AgentLoop } from '../orchestrator/loop.js';

export function createTriggerCompressionTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'trigger_compression',
    description:
      'Trigger context compression to free token space when the conversation grows too long.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const loop = agentLoop as any;
        loop.needsCompression = true;
        return '压缩已触发。将在下一轮对话前执行。';
      } catch (err) {
        return 'Error: ' + (err instanceof Error ? err.message : String(err));
      }
    },
  };
}
