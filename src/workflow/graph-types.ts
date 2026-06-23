/**
 * Graph Workflow Types — 后端图工作流类型定义
 *
 * 与前端 `webui/src/types.ts` 中的 WorkflowGraph / WorkflowGraphNode /
 * WorkflowGraphEdge / GraphNodeData 对齐，支持无限子图嵌套。
 *
 * 这些类型用于解析前端图形编辑器生成的 graph JSON，并由 graph-engine
 * 编译为 WorkflowDefinition 运行时对象。
 */

/** 节点类型 — 与设计文档对齐 */
export type WorkflowNodeType =
  | 'start'        // 开始节点
  | 'end'          // 结束节点
  | 'agent'        // Agent 节点（核心）
  | 'tool'         // 工具调用
  | 'context'      // 上下文注入
  | 'compressor'   // 压缩器
  | 'prompt'       // 提示词模板
  | 'transform'    // 数据转换
  | 'branch'       // 条件分支
  | 'loop'         // 循环
  | 'parallel'     // 并行执行
  | 'input'        // 输入端口
  | 'output'       // 输出端口
  | 'subworkflow'  // 子工作流（复合节点，可展开）
  | 'note';        // 注释节点

/** 节点端口定义 */
export interface NodePort {
  id: string;
  label: string;
  type: 'input' | 'output';
}

/** 图节点数据 */
export interface GraphNodeData {
  label: string;
  description?: string;
  nodeType: WorkflowNodeType;
  config?: Record<string, unknown>;
  /** 仅 subworkflow 类型 — 内嵌子图（inline 模式） */
  subgraph?: WorkflowGraph;
  /** 仅 subworkflow 类型 — 引用外部工作流名（reference 模式） */
  subworkflowRef?: string;
  /** 端口定义（可选，默认按 nodeType 自动生成） */
  ports?: NodePort[];
}

/** 图节点（React Flow 节点） */
export interface WorkflowGraphNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: GraphNodeData;
}

/** 图边（React Flow 边） */
export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  animated?: boolean;
}

/** 工作流图 — 可无限嵌套 */
export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  metadata?: {
    name?: string;
    description?: string;
    version?: string;
  };
}

/** 图元数据 */
export interface WorkflowGraphMetadata {
  name?: string;
  description?: string;
  version?: string;
}
