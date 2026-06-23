// ============================================================
// nodeRegistry — 节点类型元信息注册表
// ============================================================
// 遵循模块化与可插拔原则：节点类型可注册、可扩展。
// 每个节点类型的视觉表现（颜色/图标）与行为元数据集中声明，
// 编辑器与渲染组件通过此注册表查询，而非硬编码。
// ============================================================

import type { NodeTypeMeta, WorkflowNodeType } from '../../types';

/** 内建节点类型元信息 */
const BUILTIN_NODE_TYPES: NodeTypeMeta[] = [
  // ── 控制流 ──────────────────────────────────────────
  {
    type: 'start',
    label: '开始',
    category: 'control',
    icon: '▶',
    color: '#22c55e',
    description: '工作流入口节点，标记流程起始',
    hasSubgraph: false,
  },
  {
    type: 'end',
    label: '结束',
    category: 'control',
    icon: '■',
    color: '#ef4444',
    description: '工作流出口节点，标记流程终止',
    hasSubgraph: false,
  },
  {
    type: 'branch',
    label: '条件分支',
    category: 'control',
    icon: '◇',
    color: '#f59e0b',
    description: '根据条件表达式选择执行路径',
    hasSubgraph: false,
  },
  {
    type: 'loop',
    label: '循环',
    category: 'control',
    icon: '↻',
    color: '#f59e0b',
    description: '重复执行子流程直到条件不满足',
    hasSubgraph: false,
  },
  {
    type: 'parallel',
    label: '并行',
    category: 'control',
    icon: '⫴',
    color: '#f59e0b',
    description: '并行执行多条分支，全部完成后汇合',
    hasSubgraph: false,
  },

  // ── Agent 相关 ──────────────────────────────────────
  {
    type: 'agent',
    label: 'Agent',
    category: 'agent',
    icon: '🤖',
    color: '#3b82f6',
    description: '核心 Agent 节点，执行 LLM 推理与工具调用',
    hasSubgraph: false,
  },
  {
    type: 'tool',
    label: '工具',
    category: 'agent',
    icon: '🔧',
    color: '#8b5cf6',
    description: '调用指定工具并返回结果',
    hasSubgraph: false,
  },
  {
    type: 'prompt',
    label: '提示词',
    category: 'agent',
    icon: '📝',
    color: '#06b6d4',
    description: '注入提示词模板，支持变量替换',
    hasSubgraph: false,
  },

  // ── 数据处理 ────────────────────────────────────────
  {
    type: 'context',
    label: '上下文',
    category: 'data',
    icon: '📋',
    color: '#14b8a6',
    description: '注入上下文信息（知识库/历史/变量）',
    hasSubgraph: false,
  },
  {
    type: 'compressor',
    label: '压缩器',
    category: 'data',
    icon: '🗜',
    color: '#14b8a6',
    description: '压缩上下文或摘要内容',
    hasSubgraph: false,
  },
  {
    type: 'transform',
    label: '转换',
    category: 'data',
    icon: '⇄',
    color: '#14b8a6',
    description: '数据格式转换或字段映射',
    hasSubgraph: false,
  },
  {
    type: 'input',
    label: '输入',
    category: 'data',
    icon: '↘',
    color: '#64748b',
    description: '工作流输入端口，接收外部参数',
    hasSubgraph: false,
  },
  {
    type: 'output',
    label: '输出',
    category: 'data',
    icon: '↗',
    color: '#64748b',
    description: '工作流输出端口，返回结果给调用方',
    hasSubgraph: false,
  },

  // ── 复合节点 ────────────────────────────────────────
  {
    type: 'subworkflow',
    label: '子工作流',
    category: 'composite',
    icon: '⊞',
    color: '#ec4899',
    description: '嵌套子工作流（双击展开进入子图编辑）',
    hasSubgraph: true,
  },

  // ── 注释 ────────────────────────────────────────────
  {
    type: 'note',
    label: '注释',
    category: 'annotation',
    icon: '💬',
    color: '#94a3b8',
    description: '注释节点，不影响执行，仅用于说明',
    hasSubgraph: false,
  },
];

/** 节点类型 → 元信息映射 */
const NODE_TYPE_MAP: Map<WorkflowNodeType, NodeTypeMeta> = new Map(
  BUILTIN_NODE_TYPES.map(meta => [meta.type, meta]),
);

/** 按分类分组 */
const NODE_TYPES_BY_CATEGORY: Record<string, NodeTypeMeta[]> = BUILTIN_NODE_TYPES.reduce(
  (acc, meta) => {
    if (!acc[meta.category]) acc[meta.category] = [];
    acc[meta.category].push(meta);
    return acc;
  },
  {} as Record<string, NodeTypeMeta[]>,
);

/** 获取节点类型元信息 */
export function getNodeTypeMeta(type: WorkflowNodeType): NodeTypeMeta | undefined {
  return NODE_TYPE_MAP.get(type);
}

/** 获取所有内建节点类型 */
export function getAllNodeTypes(): NodeTypeMeta[] {
  return BUILTIN_NODE_TYPES;
}

/** 按分类获取节点类型 */
export function getNodeTypesByCategory(): Record<string, NodeTypeMeta[]> {
  return NODE_TYPES_BY_CATEGORY;
}

/** 分类标签映射 */
export const CATEGORY_LABELS: Record<string, string> = {
  control: '控制流',
  agent: 'Agent',
  data: '数据处理',
  composite: '复合节点',
  annotation: '注释',
};

/** 注册自定义节点类型（可插拔扩展点） */
export function registerNodeType(meta: NodeTypeMeta): void {
  NODE_TYPE_MAP.set(meta.type, meta);
  if (!NODE_TYPES_BY_CATEGORY[meta.category]) {
    NODE_TYPES_BY_CATEGORY[meta.category] = [];
  }
  const existing = NODE_TYPES_BY_CATEGORY[meta.category].findIndex(m => m.type === meta.type);
  if (existing >= 0) {
    NODE_TYPES_BY_CATEGORY[meta.category][existing] = meta;
  } else {
    NODE_TYPES_BY_CATEGORY[meta.category].push(meta);
  }
}
