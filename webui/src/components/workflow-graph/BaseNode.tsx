// ============================================================
// BaseNode — 通用节点渲染组件
// ============================================================
// 根据节点类型从注册表查询元信息（颜色/图标/标签），
// 统一渲染节点外观。复合节点（subworkflow）显示子图标识。
// ============================================================

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { getNodeTypeMeta } from './nodeRegistry';
import type { GraphNodeData, WorkflowNodeType } from '../../types';

/** 是否需要输入端口 */
function hasInputHandle(type: WorkflowNodeType): boolean {
  return type !== 'start' && type !== 'input' && type !== 'note';
}

/** 是否需要输出端口 */
function hasOutputHandle(type: WorkflowNodeType): boolean {
  return type !== 'end' && type !== 'output' && type !== 'note';
}

/** branch 节点的多输出端口 */
const BRANCH_OUTPUTS = [
  { id: 'true', label: '是' },
  { id: 'false', label: '否' },
];

function BaseNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as GraphNodeData;
  const meta = getNodeTypeMeta(nodeData.nodeType);
  const color = meta?.color ?? '#64748b';
  const icon = meta?.icon ?? '○';
  const label = nodeData.label || meta?.label || nodeData.nodeType;
  const isSubworkflow = nodeData.nodeType === 'subworkflow';
  const isNote = nodeData.nodeType === 'note';
  const isBranch = nodeData.nodeType === 'branch';
  const hasSubgraph = isSubworkflow && (nodeData.subgraph || nodeData.subworkflowRef);

  // 注释节点：无边框，纯文本
  if (isNote) {
    return (
      <div
        style={{
          background: 'rgba(148, 163, 184, 0.1)',
          border: '1px dashed rgba(148, 163, 184, 0.4)',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 11,
          color: '#94a3b8',
          maxWidth: 200,
          fontStyle: 'italic',
        }}
      >
        {label}
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: `2px solid ${selected ? color : 'var(--border)'}`,
        borderRadius: 8,
        padding: 0,
        minWidth: 140,
        maxWidth: 220,
        boxShadow: selected ? `0 0 0 2px ${color}33` : '0 1px 3px rgba(0,0,0,0.1)',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* 输入端口 */}
      {hasInputHandle(nodeData.nodeType) && (
        <Handle
          type="target"
          position={Position.Left}
          style={{
            background: color,
            width: 8,
            height: 8,
            border: '2px solid var(--surface)',
          }}
        />
      )}

      {/* 节点头部 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          background: `${color}11`,
          borderRadius: '6px 6px 0 0',
        }}
      >
        <span style={{ fontSize: 14, lineHeight: 1 }}>{icon}</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        {hasSubgraph && (
          <span
            title="包含子图 — 双击展开"
            style={{
              fontSize: 10,
              color: color,
              fontWeight: 700,
            }}
          >
            ⊞
          </span>
        )}
      </div>

      {/* 节点描述 */}
      {nodeData.description && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 10,
            color: 'var(--muted)',
            lineHeight: 1.4,
          }}
        >
          {nodeData.description}
        </div>
      )}

      {/* subworkflow 引用标识 */}
      {isSubworkflow && nodeData.subworkflowRef && (
        <div
          style={{
            padding: '2px 10px 6px',
            fontSize: 10,
            color: 'var(--accent)',
            fontFamily: 'monospace',
          }}
        >
          ↳ {nodeData.subworkflowRef}
        </div>
      )}

      {/* subworkflow 内嵌子图节点数 */}
      {isSubworkflow && nodeData.subgraph && (
        <div
          style={{
            padding: '2px 10px 6px',
            fontSize: 10,
            color: 'var(--accent)',
          }}
        >
          ↳ {nodeData.subgraph.nodes.length} 节点（内嵌）
        </div>
      )}

      {/* 输出端口 */}
      {hasOutputHandle(nodeData.nodeType) && !isBranch && (
        <Handle
          type="source"
          position={Position.Right}
          style={{
            background: color,
            width: 8,
            height: 8,
            border: '2px solid var(--surface)',
          }}
        />
      )}

      {/* branch 节点的多输出端口 */}
      {isBranch &&
        BRANCH_OUTPUTS.map((port, idx) => (
          <Handle
            key={port.id}
            type="source"
            position={Position.Right}
            id={port.id}
            style={{
              background: color,
              width: 8,
              height: 8,
              border: '2px solid var(--surface)',
              top: `calc(${(idx + 1) * 100 / (BRANCH_OUTPUTS.length + 1)}%)`,
            }}
          />
        ))}
    </div>
  );
}

export const BaseNode = memo(BaseNodeComponent);
