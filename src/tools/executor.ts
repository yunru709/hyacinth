import type { ToolCall, ToolResult } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { getToolConfig } from './tool-config.js';
import { runAttributed } from '../kernel/security/index.js';

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
   * @param defaultTimeout  默认超时时间（毫秒）；未显式传入时读 tools.executor.timeoutMs（默认 300000）
   */
  constructor(registry: ToolRegistry, defaultTimeout?: number) {
    this.registry = registry;
    // 显式编程注入优先于配置（测试用显式超时不受 config 影响）
    this.defaultTimeout = defaultTimeout ?? getToolConfig('executor.timeoutMs', 300_000);
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

    // AbortController 支撑超时真正中断工具（而非 Promise.race 后放任底层继续跑）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      // 安全内核归因：工具执行期内的 spawn/fetch 受最严策略（kernel/security）
      const toolSource = (tool as { source?: string }).source;
      const result = await runAttributed(
        { kind: 'tool', name: `${toolSource ?? 'core'}:${toolCall.name}` },
        () => tool.execute(toolCall.input, controller.signal),
      );
      // 超时 abort 后工具若"配合地"正常返回，仍应视为超时而非成功
      if (controller.signal.aborted) {
        return {
          tool_use_id: toolCall.id,
          content: `Tool execution timed out after ${this.defaultTimeout / 1000} seconds and was aborted`,
          is_error: true,
        };
      }
      return {
        tool_use_id: toolCall.id,
        content: result,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        return {
          tool_use_id: toolCall.id,
          content: `Tool execution timed out after ${this.defaultTimeout / 1000} seconds and was aborted`,
          is_error: true,
        };
      }
      return {
        tool_use_id: toolCall.id,
        content: message,
        is_error: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 并行执行多个工具调用
   */
  async executeParallel(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(toolCalls.map((tc) => this.execute(tc)));
  }
}
