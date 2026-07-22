/**
 * trigger_compression — 手动触发上下文压缩
 */
import type { Tool } from './interface.js';
import type { AgentLoop } from '../orchestrator/loop.js';

export function createTriggerCompressionTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'trigger_compression',
    description:
      '手动触发上下文压缩以释放 Token 空间。适用于对话过长、上下文使用率较高时，或在开始需要大量上下文的新任务之前主动清理。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const loop = agentLoop as any;
        loop.needsCompression = true;
        return 'Compression triggered. Will execute before the next turn.';
      } catch (err) {
        return 'Error: ' + (err instanceof Error ? err.message : String(err));
      }
    },
  };
}
