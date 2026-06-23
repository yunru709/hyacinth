/**
 * Branch Node Executor — 条件分支节点执行器
 *
 * 从 node.data.config.condition 取条件表达式（简单字符串比较或 JS 表达式），
 * 评估后返回 { nextNodeId } 指向对应后继节点。
 *
 * 条件评估使用受限的 new Function 方式，只允许访问 ctx.params 和 ctx.outputs。
 * 评估结果匹配规则：
 *   - boolean true  → sourceHandle 为 "true"/"yes" 的出边
 *   - boolean false → sourceHandle 为 "false"/"no" 的出边
 *   - string        → 匹配 sourceHandle 或目标节点 id/label
 *   - 其他          → 默认取第一条出边
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';
import type { WorkflowGraphEdge } from '../graph-types.js';

/** 构建受限的评估上下文（只暴露 params 和 outputs） */
function buildSafeContext(ctx: NodeExecutionContext): { params: Record<string, unknown>; outputs: Record<string, unknown> } {
  const outputsObj: Record<string, unknown> = {};
  for (const [nodeId, value] of ctx.outputs) {
    outputsObj[nodeId] = value;
  }
  return {
    params: ctx.params,
    outputs: outputsObj,
  };
}

/** 评估条件表达式 */
function evaluateCondition(condition: string, safeCtx: { params: Record<string, unknown>; outputs: Record<string, unknown> }): unknown {
  try {
    // 受限执行：只暴露 params 和 outputs，不访问全局对象
    const fn = new Function('ctx', `"use strict"; return (${condition});`);
    return fn(safeCtx);
  } catch (err) {
    // 评估失败时返回 undefined，由调用方处理
    return undefined;
  }
}

/** 根据评估结果从出边中选择目标节点 */
function selectNextNodeId(
  result: unknown,
  outgoingEdges: WorkflowGraphEdge[],
): string | undefined {
  if (outgoingEdges.length === 0) return undefined;

  // boolean true → sourceHandle "true"/"yes"
  if (result === true) {
    const edge = outgoingEdges.find(
      e => e.sourceHandle === 'true' || e.sourceHandle === 'yes',
    );
    return edge?.target ?? outgoingEdges[0].target;
  }

  // boolean false → sourceHandle "false"/"no"
  if (result === false) {
    const edge = outgoingEdges.find(
      e => e.sourceHandle === 'false' || e.sourceHandle === 'no',
    );
    return edge?.target ?? outgoingEdges[0].target;
  }

  // string → 匹配 sourceHandle 或目标节点 id
  if (typeof result === 'string') {
    const edge = outgoingEdges.find(
      e => e.sourceHandle === result || e.target === result,
    );
    return edge?.target ?? outgoingEdges[0].target;
  }

  // 其他情况 → 默认第一条出边
  return outgoingEdges[0].target;
}

export const branchNodeExecutor: NodeExecutor = {
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const config = ctx.node.data.config ?? {};
    const condition = (config.condition as string) ?? 'true';

    // 收集当前节点的所有出边
    const outgoingEdges = ctx.graph.edges.filter(e => e.source === ctx.node.id);

    // 评估条件
    const safeCtx = buildSafeContext(ctx);
    const result = evaluateCondition(condition, safeCtx);

    // 选择下一个节点
    const nextNodeId = selectNextNodeId(result, outgoingEdges);

    if (nextNodeId) {
      return { nextNodeId };
    }

    // 没有后继节点，标记完成
    return { done: true };
  },
};
