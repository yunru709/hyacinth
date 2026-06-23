/**
 * Tool Node Executor — 工具调用节点执行器
 *
 * 从 node.data.config.toolName 取工具名，生成提示词要求 LLM 调用指定工具，
 * 并标记 waitForResponse 以暂停执行等待工具结果。
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';

export const toolNodeExecutor: NodeExecutor = {
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const config = ctx.node.data.config ?? {};
    const toolName = (config.toolName as string) ?? 'unknown_tool';
    const args = config.args;

    let prompt: string;
    if (args !== undefined) {
      const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
      prompt = `请调用工具 ${toolName}，参数：${argsStr}`;
    } else {
      prompt = `请调用工具 ${toolName}`;
    }

    return { prompt, waitForResponse: true };
  },
};
