/**
 * End Node Executor — 结束节点执行器
 *
 * 工作流的出口节点，标记工作流执行完成，返回完成提示词。
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';

export const endNodeExecutor: NodeExecutor = {
  execute(_ctx: NodeExecutionContext): NodeExecutionResult {
    return { done: true, prompt: '工作流执行完成' };
  },
};
