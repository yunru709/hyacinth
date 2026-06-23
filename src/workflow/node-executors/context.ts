/**
 * Context Node Executor — 上下文注入节点执行器
 *
 * 从 node.data.config.content 取内容，作为持久化上下文返回
 * （注入 Zone 5 workflow_persistent）。
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';

export const contextNodeExecutor: NodeExecutor = {
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const config = ctx.node.data.config ?? {};
    const content = (config.content as string) ?? '';

    return { persistent: content };
  },
};
