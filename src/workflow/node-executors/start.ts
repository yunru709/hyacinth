/**
 * Start Node Executor — 开始节点执行器
 *
 * 工作流的入口节点，不产生任何提示词或输出，仅标记工作流开始。
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';

export const startNodeExecutor: NodeExecutor = {
  execute(_ctx: NodeExecutionContext): NodeExecutionResult {
    return { done: false };
  },
};
