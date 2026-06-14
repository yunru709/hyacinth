/**
 * trigger_compression — 手动触发上下文压缩
 */
import type { Tool } from './interface.js';
import type { AgentLoop } from '../orchestrator/loop.js';

export function createTriggerCompressionTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'trigger_compression',
    description:
      '手动触发上下文压缩。当对话历史过长、token 接近上限时，可主动调用此工具压缩历史记录以释放空间。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        // 设置 needsCompression 标志，下一轮 runTurn 会触发压缩
        (agentLoop as any).needsCompression = true;
        return '压缩已触发，将在下一轮对话前执行。';
      } catch (err) {
        return 'Error: ' + (err instanceof Error ? err.message : String(err));
      }
    },
  };
}
