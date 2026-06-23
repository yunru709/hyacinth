/**
 * Node Executor Types — 节点执行器接口定义
 *
 * 定义节点执行上下文（NodeExecutionContext）、执行结果（NodeExecutionResult）
 * 和执行器接口（NodeExecutor）。
 *
 * 每种节点类型（start/end/agent/tool/...）实现 NodeExecutor 接口，
 * 通过 NodeExecutorRegistry 注册到系统中，遵循可插拔设计原则。
 */

import type { GraphNodeData, WorkflowGraph } from '../graph-types.js';

/** 节点执行上下文 */
export interface NodeExecutionContext {
  /** 当前节点数据 */
  node: { id: string; type: string; data: GraphNodeData };
  /** 整个图（用于 subworkflow 访问子图） */
  graph: WorkflowGraph;
  /** 节点输出表（nodeId → output） */
  outputs: Map<string, unknown>;
  /** 已累积的提示词（供 Zone 5 注入） */
  prompts: string[];
  /** 工作流参数 */
  params: Record<string, unknown>;
  /** 当前步骤 ID（用于 step action） */
  currentStepId?: number;
}

/** 节点执行结果 */
export interface NodeExecutionResult {
  /** 该节点产生的提示词（注入 Zone 5 workflow_step） */
  prompt?: string;
  /** 持久化内容（注入 Zone 5 workflow_persistent） */
  persistent?: string;
  /** 输出值（传递给后继节点） */
  output?: unknown;
  /** 选择的下一个节点 ID（branch 节点用，覆盖默认后继） */
  nextNodeId?: string;
  /** 是否已完成（end 节点用） */
  done?: boolean;
  /** 是否需要等待 LLM/工具响应（agent/tool 节点用） */
  waitForResponse?: boolean;
}

/** 节点执行器接口 — 任何实现此接口的对象都是节点执行器 */
export interface NodeExecutor {
  /** 执行节点 */
  execute(ctx: NodeExecutionContext): NodeExecutionResult | Promise<NodeExecutionResult>;
}
