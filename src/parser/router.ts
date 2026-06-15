import type { StreamEvent } from '../types.js';

/**
 * 根据 StreamEvent 类型路由到不同的处理器。
 *
 * 使用方式：
 * ```ts
 * const router = new OutputRouter();
 * router.onText = (content) => process.stdout.write(content);
 * router.onThinking = (content) => logger.debug(content);
 * router.onToolUse = (id, name, input) => executeTool(id, name, input);
 * router.onUsage = (input, output) => trackUsage(input, output);
 * router.onStop = (reason) => handleStop(reason);
 *
 * // 与 parser 配合使用
 * await parseAnthropicStream(stream, (event) => router.route(event));
 * ```
 */
export class OutputRouter {
  onText: ((content: string) => void) | null = null;
  onThinking: ((content: string) => void) | null = null;
  onToolUse: ((id: string, name: string, input: Record<string, unknown>) => void) | null = null;
  onUsage: ((inputTokens: number, outputTokens: number, cacheHitTokens?: number, cacheMissTokens?: number, cacheReadInputTokens?: number, cacheCreationInputTokens?: number) => void) | null = null;
  onStop: ((reason: string) => void) | null = null;

  /**
   * 将 StreamEvent 路由到对应的处理器回调。
   * 如果某个事件类型没有注册处理器，则静默忽略。
   */
  route(event: StreamEvent): void {
    switch (event.type) {
      case 'TEXT': {
        this.onText?.(event.content);
        break;
      }
      case 'THINKING': {
        this.onThinking?.(event.content);
        break;
      }
      case 'TOOL_USE': {
        this.onToolUse?.(event.id, event.name, event.input);
        break;
      }
      case 'USAGE': {
        this.onUsage?.(event.input_tokens, event.output_tokens, event.cache_hit_tokens, event.cache_miss_tokens, event.cache_read_input_tokens, event.cache_creation_input_tokens);
        break;
      }
      case 'STOP': {
        this.onStop?.(event.reason);
        break;
      }
      case 'IMAGE': {
        // 模型生成的图片 — 后续由 loop.ts 写入 responseMessages
        break;
      }
      default: {
        // 类型安全：确保所有 StreamEventType 都已处理
        const _exhaustive: never = event;
        break;
      }
    }
  }
}
