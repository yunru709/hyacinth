import type { ToolCall, ToolResult } from '../types.js';
import type { ToolRegistry } from './registry.js';

/**
 * ToolExecutor — 调度工具执行
 *
 * 职责：
 * - 根据工具调用请求查找并执行对应工具
 * - 处理超时和错误
 * - 返回结构化结果（ToolResult）
 */
export class ToolExecutor {
  private registry: ToolRegistry;
  private defaultTimeout: number;

  /**
   * @param registry  工具注册表
   * @param defaultTimeout  默认超时时间（毫秒），默认 300000 (5 分钟)
   */
  constructor(registry: ToolRegistry, defaultTimeout?: number) {
    this.registry = registry;
    this.defaultTimeout = defaultTimeout ?? 300_000;
  }

  /**
   * 执行单个工具调用
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    // 查找工具
    const tool = this.registry.get(toolCall.name);
    if (!tool) {
      return {
        tool_use_id: toolCall.id,
        content: `Unknown tool: ${toolCall.name}`,
        is_error: true,
      };
    }

    try {
      // 带超时执行
      const result = await this.withTimeout(
        tool.execute(toolCall.input),
        this.defaultTimeout
      );
      return {
        tool_use_id: toolCall.id,
        content: result,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        tool_use_id: toolCall.id,
        content: message,
        is_error: true,
      };
    }
  }

  /**
   * 并行执行多个工具调用
   */
  async executeParallel(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(toolCalls.map((tc) => this.execute(tc)));
  }

  /**
   * 为 Promise 添加超时控制
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Tool execution timed out after ${ms / 1000} seconds`)),
          ms
        )
      ),
    ]);
  }
}
