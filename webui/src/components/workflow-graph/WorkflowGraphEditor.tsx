// ============================================================
// WorkflowGraphEditor — 工作流图形编辑器
// ============================================================
// 基于 React Flow 实现：
//   - 节点拖拽创建（从节点面板拖入画布）
//   - 连线（拖拽端口）
//   - 子图展开（双击 subworkflow 节点进入子图，面包屑导航返回）
//   - 无限嵌套支持
//   - JSON 序列化（与后端 workflow 格式对齐）
//
// 数据流：根图 → breadcrumb 路径 → 当前子图引用
// 编辑操作直接修改当前子图引用（深拷贝后替换），保证 React 响应。
// ============================================================

import { useState, useCallback, useMemo, useRef, type DragEvent } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { BaseNode } from './BaseNode';
import { getAllNodeTypes, getNodeTypesByCategory, CATEGORY_LABELS, getNodeTypeMeta } from './nodeRegistry';
import type {
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowGraphEdge,
  WorkflowNodeType,
  GraphNodeData,
  GraphBreadcrumb,
} from '../../types';

// ── React Flow 节点类型映射 ──────────────────────────────
// 所有内建节点类型统一使用 BaseNode 渲染
const nodeTypes: NodeTypes = (() => {
  const map: NodeTypes = {};
  for (const meta of getAllNodeTypes()) {
    map[meta.type] = BaseNode;
  }
  return map;
})();

// ── 工具函数 ──────────────────────────────────────────────

/** 生成唯一 ID */
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 创建默认节点数据 */
function createNodeData(type: WorkflowNodeType): GraphNodeData {
  const meta = getNodeTypeMeta(type);
  return {
    label: meta?.label ?? type,
    nodeType: type,
    description: meta?.description,
  };
}

/** 创建默认节点 */
function createNode(type: WorkflowNodeType, position: { x: number; y: number }): WorkflowGraphNode {
  return {
    id: genId(type),
    type,
    position,
    data: createNodeData(type),
  };
}

/** 深拷贝（用于子图编辑时保持不可变性） */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/** 根据面包屑路径从根图获取当前子图引用 */
function getSubgraphByPath(graph: WorkflowGraph, path: GraphBreadcrumb[]): WorkflowGraph | null {
  if (path.length === 0) return graph;
  let current: WorkflowGraph = graph;
  for (const crumb of path) {
    const node = current.nodes.find(n => n.id === crumb.nodeId);
    if (!node || !node.data.subgraph) return null;
    current = node.data.subgraph;
  }
  return current;
}

// ── 节点面板（左侧） ──────────────────────────────────────

function NodePalette({ onDragStart }: { onDragStart: (e: DragEvent, type: WorkflowNodeType) => void }) {
  const byCategory = getNodeTypesByCategory();

  return (
    <div
      style={{
        width: 180,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        overflowY: 'auto',
        padding: '8px',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--muted)',
          marginBottom: 8,
        }}
      >
        节点类型
      </div>
      {Object.entries(byCategory).map(([cat, types]) => (
        <div key={cat} style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--text-dim)',
              marginBottom: 4,
              paddingBottom: 2,
              borderBottom: '1px solid var(--border)',
            }}
          >
            {CATEGORY_LABELS[cat] ?? cat}
          </div>
          {types.map(meta => (
            <div
              key={meta.type}
              draggable
              onDragStart={e => onDragStart(e, meta.type)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 6px',
                marginBottom: 2,
                borderRadius: 4,
                cursor: 'grab',
                fontSize: 11,
                color: 'var(--text)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--surface-hover)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'var(--surface)';
              }}
              title={meta.description}
            >
              <span style={{ color: meta.color, fontSize: 13 }}>{meta.icon}</span>
              <span>{meta.label}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── 面包屑导航 ──────────────────────────────────────────────

function Breadcrumb({
  path,
  onNavigate,
}: {
  path: GraphBreadcrumb[];
  onNavigate: (index: number) => void;
}) {
  if (path.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--muted)', padding: '4px 0' }}>
        根图
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        flexWrap: 'wrap',
        fontSize: 11,
        padding: '4px 0',
      }}
    >
      <span
        style={{ color: 'var(--accent)', cursor: 'pointer' }}
        onClick={() => onNavigate(-1)}
      >
        根图
      </span>
      {path.map((crumb, idx) => (
        <span key={crumb.nodeId} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--muted)' }}>/</span>
          <span
            style={{
              color: idx === path.length - 1 ? 'var(--text)' : 'var(--accent)',
              cursor: 'pointer',
              fontWeight: idx === path.length - 1 ? 600 : 400,
            }}
            onClick={() => onNavigate(idx)}
          >
            {crumb.label}
          </span>
        </span>
      ))}
    </div>
  );
}

// ── 编辑器内部组件（在 ReactFlowProvider 内） ─────────────

function GraphEditorInner({
  graph,
  onGraphChange,
}: {
  graph: WorkflowGraph;
  onGraphChange: (g: WorkflowGraph) => void;
}) {
  const [breadcrumb, setBreadcrumb] = useState<GraphBreadcrumb[]>([]);
  const draggingTypeRef = useRef<WorkflowNodeType | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 当前子图（根据面包屑路径获取）
  const currentSubgraph = useMemo<WorkflowGraph>(() => {
    const sub = getSubgraphByPath(graph, breadcrumb);
    return sub ?? { nodes: [], edges: [] };
  }, [graph, breadcrumb]);

  // React Flow 状态（使用当前子图的节点和边）
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>(
    currentSubgraph.nodes as unknown as Node[],
  );
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>(
    currentSubgraph.edges as unknown as Edge[],
  );

  // 当面包屑或根图变化时，同步 React Flow 状态
  // 使用 useMemo 的副作用方式不可取，改用 key 重新挂载
  // 这里通过 wrapper key 实现重新挂载
  const remountKey = useMemo(() => {
    return breadcrumb.map(b => b.nodeId).join('|') + '_' + JSON.stringify(graph.metadata);
  }, [breadcrumb, graph.metadata]);

  // 连线处理
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const newEdge: WorkflowGraphEdge = {
        id: genId('edge'),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? undefined,
        targetHandle: connection.targetHandle ?? undefined,
        animated: true,
      };
      setRfEdges(eds => addEdge({ ...newEdge, markerEnd: { type: MarkerType.ArrowClosed } }, eds) as Edge[]);
      persistToGraph();
    },
    [setRfEdges],
  );

  // 将 React Flow 状态持久化回 graph 对象
  const persistToGraph = useCallback(() => {
    const newGraph = deepClone(graph);
    const target = getSubgraphByPath(newGraph, breadcrumb);
    if (target) {
      target.nodes = rfNodes as unknown as WorkflowGraphNode[];
      target.edges = rfEdges as unknown as WorkflowGraphEdge[];
      onGraphChange(newGraph);
    }
  }, [rfNodes, rfEdges, graph, breadcrumb, onGraphChange]);

  // 节点变化时持久化
  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
      // 延迟持久化，等状态更新完成
      setTimeout(persistToGraph, 0);
    },
    [onNodesChange, persistToGraph],
  );

  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes);
      setTimeout(persistToGraph, 0);
    },
    [onEdgesChange, persistToGraph],
  );

  // 拖拽创建节点
  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const type = draggingTypeRef.current;
      if (!type || !wrapperRef.current) return;

      const bounds = wrapperRef.current.getBoundingClientRect();
      const position = {
        x: e.clientX - bounds.left - 70,
        y: e.clientY - bounds.top - 20,
      };

      const newNode = createNode(type, position);
      setRfNodes(nds => [...nds, newNode as unknown as Node]);
      setTimeout(persistToGraph, 0);
      draggingTypeRef.current = null;
    },
    [setRfNodes, persistToGraph],
  );

  const handleDragStart = useCallback((e: DragEvent, type: WorkflowNodeType) => {
    draggingTypeRef.current = type;
    e.dataTransfer.setData('application/workflow-node', type);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  // 双击 subworkflow 节点 → 进入子图
  const onNodeDoubleClick = useCallback(
    (_evt: unknown, node: Node) => {
      const wfNode = node as unknown as WorkflowGraphNode;
      if (wfNode.data.nodeType !== 'subworkflow') return;

      // 如果子图为空，创建空子图
      if (!wfNode.data.subgraph) {
        const newGraph = deepClone(graph);
        const target = getSubgraphByPath(newGraph, breadcrumb);
        if (target) {
          const nodeRef = target.nodes.find(n => n.id === wfNode.id);
          if (nodeRef) {
            nodeRef.data.subgraph = { nodes: [], edges: [], metadata: { name: wfNode.data.label } };
            onGraphChange(newGraph);
          }
        }
      }

      setBreadcrumb(prev => [
        ...prev,
        { nodeId: wfNode.id, label: wfNode.data.label || '子图' },
      ]);
    },
    [graph, breadcrumb, onGraphChange],
  );

  // 面包屑导航
  const navigateTo = useCallback(
    (index: number) => {
      if (index < 0) {
        setBreadcrumb([]);
      } else {
        setBreadcrumb(prev => prev.slice(0, index + 1));
      }
    },
    [],
  );

  // 工具栏操作
  const handleClear = useCallback(() => {
    if (!confirm('清空当前画布的所有节点和连线？')) return;
    setRfNodes([]);
    setRfEdges([]);
    setTimeout(persistToGraph, 0);
  }, [setRfNodes, setRfEdges, persistToGraph]);

  const handleExport = useCallback(() => {
    const json = JSON.stringify(graph, null, 2);
    navigator.clipboard.writeText(json).then(
      () => alert('工作流 JSON 已复制到剪贴板'),
      () => console.log(json),
    );
  }, [graph]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部工具栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 8px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          flexShrink: 0,
        }}
      >
        <Breadcrumb path={breadcrumb} onNavigate={navigateTo} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={handleExport}
            style={{
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            导出 JSON
          </button>
          <button
            onClick={handleClear}
            style={{
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--danger)',
              background: 'transparent',
              color: 'var(--danger)',
              cursor: 'pointer',
            }}
          >
            清空
          </button>
        </div>
      </div>

      {/* 主体区域：节点面板 + 画布 */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <NodePalette onDragStart={handleDragStart} />

        <div
          ref={wrapperRef}
          style={{ flex: 1, position: 'relative', minHeight: 0 }}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <ReactFlow
            key={remountKey}
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            onNodeDoubleClick={onNodeDoubleClick}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode={['Delete', 'Backspace']}
            style={{ background: 'var(--bg)' }}
          >
            <Background color="var(--border)" gap={16} />
            <Controls />
            <MiniMap
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
              }}
              nodeColor={node => {
                const data = node.data as unknown as GraphNodeData;
                return getNodeTypeMeta(data.nodeType)?.color ?? '#64748b';
              }}
            />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}

// ── 对外导出的编辑器组件（包裹 ReactFlowProvider） ─────────

export interface WorkflowGraphEditorProps {
  graph: WorkflowGraph;
  onGraphChange: (g: WorkflowGraph) => void;
}

export function WorkflowGraphEditor(props: WorkflowGraphEditorProps) {
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 400 }}>
      <ReactFlowProvider>
        <GraphEditorInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}

// ── 工厂函数：创建空图 ─────────────────────────────────────

export function createEmptyGraph(name?: string, description?: string): WorkflowGraph {
  return {
    nodes: [],
    edges: [],
    metadata: {
      name: name ?? '未命名工作流',
      description: description ?? '',
      version: '1.0.0',
    },
  };
}

// ── 工厂函数：创建带 start/end 的示例图 ────────────────────

export function createStarterGraph(name?: string): WorkflowGraph {
  const startNode = createNode('start', { x: 80, y: 200 });
  const agentNode = createNode('agent', { x: 320, y: 200 });
  const endNode = createNode('end', { x: 560, y: 200 });

  return {
    nodes: [startNode, agentNode, endNode],
    edges: [
      {
        id: genId('edge'),
        source: startNode.id,
        target: agentNode.id,
        animated: true,
      },
      {
        id: genId('edge'),
        source: agentNode.id,
        target: endNode.id,
        animated: true,
      },
    ],
    metadata: {
      name: name ?? '示例工作流',
      description: 'Start → Agent → End 基础流程',
      version: '1.0.0',
    },
  };
}
