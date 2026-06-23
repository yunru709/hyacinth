/**
 * Note Node Executor — 注释节点执行器
 *
 * 空操作节点，仅用于在图中添加注释/说明，不影响执行流程。
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';

export const noteNodeExecutor: NodeExecutor = {
  execute(_ctx: NodeExecutionContext): NodeExecutionResult {
    return {};
  },
};
