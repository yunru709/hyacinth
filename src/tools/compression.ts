/**
 * trigger_compression — 手动触发上下文压缩
 */
import type { Tool } from './interface.js';
import type { AgentLoop } from '../orchestrator/loop.js';

export function createTriggerCompressionTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'trigger_compression',
    description:
      'Trigger context compression to free token space when the conversation grows too long. ' +
      'Optional strategy: A=independent prompt, C=clone context (cache-friendly, lower cost with same model/provider).',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          enum: ['A', 'C'],
          description:
            'Compression strategy. A=independent prompt, C=clone context (cache hits on system+history). Uses config default if omitted.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const loop = agentLoop as any;
        loop.needsCompression = true;

        const strategy = args.strategy as string | undefined;
        if (strategy === 'A' || strategy === 'C') {
          loop.pendingCompressionStrategy = strategy;
          const desc = strategy === 'C'
            ? '克隆对话模式（缓存友好）'
            : '独立提示词模式';
          return `压缩已触发，策略: ${desc}。将在下一轮对话前执行。`;
        }

        // 未指定策略时，仍需设置非空标记以触发压缩条件检查
        // 策略从 config 读取（loop.ts:1383-1386）
        loop.pendingCompressionStrategy = '_default';
        return '压缩已触发，使用当前配置的策略。将在下一轮对话前执行。';
      } catch (err) {
        return 'Error: ' + (err instanceof Error ? err.message : String(err));
      }
    },
  };
}
