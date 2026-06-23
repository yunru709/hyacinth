import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import type { WorkflowStatus, WorkflowStepInfo, WorkflowGraph } from '../types';
import {
  WorkflowGraphEditor,
  createEmptyGraph,
  createStarterGraph,
} from './workflow-graph/WorkflowGraphEditor';

type ViewMode = 'list' | 'editor';

export function WorkflowPanel() {
  const workflows = useStore(s => s.workflows);

  const [view, setView] = useState<ViewMode>('list');
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [taskInput, setTaskInput] = useState('');

  // 图形编辑器状态
  const [graph, setGraph] = useState<WorkflowGraph>(() => createStarterGraph());

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/workflows/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, 3000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    useStore.setState({ toast: { message, type } });
  };

  const handleActivate = async (name: string) => {
    setActivating(name);
    try {
      const params = taskInput.trim() ? { task: taskInput.trim() } : {};
      const res = await fetch('/api/workflows/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, params }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`工作流 "${name}" 已激活`);
        setTaskInput('');
        await fetchStatus();
      } else {
        showToast(`激活失败: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`激活失败: ${err}`, 'error');
    } finally {
      setActivating(null);
    }
  };

  const handleDeactivate = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/workflows/deactivate', {
        method: 'POST',
      });
      if (res.ok) {
        showToast('工作流已停用');
        await fetchStatus();
      }
    } catch (err) {
      showToast(`停用失败: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleNewGraph = () => {
    if (confirm('创建新的空白工作流图？当前编辑内容将丢失。')) {
      setGraph(createEmptyGraph('新工作流'));
    }
  };

  const handleLoadStarter = () => {
    setGraph(createStarterGraph('示例工作流'));
  };

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const name = graph.metadata?.name;
    if (!name) {
      showToast('工作流未命名，无法保存', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/workflows/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, graph }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`工作流 "${name}" 已保存${data.registered ? '并注册' : ''}`);
      } else {
        showToast(`保存失败: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`保存失败: ${err}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleNameChange = (name: string) => {
    setGraph({
      ...graph,
      metadata: {
        ...graph.metadata,
        name,
      },
    });
  };

  return (
    <div className="space-y-3 text-sm" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 视图切换 Tab */}
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: 2,
          background: 'var(--bg)',
          borderRadius: 6,
          border: '1px solid var(--border)',
        }}
      >
        <button
          onClick={() => setView('list')}
          style={{
            flex: 1,
            padding: '4px 8px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 4,
            border: 'none',
            cursor: 'pointer',
            background: view === 'list' ? 'var(--accent)' : 'transparent',
            color: view === 'list' ? '#fff' : 'var(--text)',
          }}
        >
          列表
        </button>
        <button
          onClick={() => setView('editor')}
          style={{
            flex: 1,
            padding: '4px 8px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 4,
            border: 'none',
            cursor: 'pointer',
            background: view === 'editor' ? 'var(--accent)' : 'transparent',
            color: view === 'editor' ? '#fff' : 'var(--text)',
          }}
        >
          图形编辑器
        </button>
      </div>

      {/* 列表视图 */}
      {view === 'list' && (
        <div className="space-y-4" style={{ overflowY: 'auto', flex: 1 }}>
          {/* 当前激活的工作流 */}
          {status?.active && (
            <div className="card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                  当前工作流
                </div>
                <button
                  onClick={handleDeactivate}
                  disabled={loading}
                  className="btn btn-sm"
                  style={{ background: 'var(--danger)', color: '#fff', border: 'none' }}
                >
                  {loading ? '停用中...' : '停用'}
                </button>
              </div>
              <div className="font-semibold" style={{ color: 'var(--text)' }}>
                {status.name}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
                {status.description}
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span style={{ color: 'var(--muted)' }}>阶段:</span>
                <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--accent)', color: '#fff' }}>
                  {status.phase ?? '-'}
                </span>
              </div>
              {status.startedAt && (
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  启动时间: {new Date(status.startedAt).toLocaleString()}
                </div>
              )}

              {/* 步骤列表 */}
              {status.steps.length > 0 && (
                <div className="space-y-1 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                  <div className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
                    步骤 ({status.steps.filter(s => s.status === 'completed').length}/{status.steps.length})
                  </div>
                  {status.steps.map(step => (
                    <StepItem key={step.id} step={step} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 任务输入框 */}
          {!status?.active && (
            <div className="card p-3 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                任务描述
              </div>
              <textarea
                value={taskInput}
                onChange={e => setTaskInput(e.target.value)}
                placeholder="输入任务描述（激活工作流时作为 params.task 传入）"
                className="w-full rounded-md p-2 text-xs resize-none"
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  minHeight: 60,
                }}
              />
            </div>
          )}

          {/* 工作流列表 */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
              可用工作流 ({workflows.length})
            </div>
            {workflows.length === 0 ? (
              <div className="text-xs text-center py-8" style={{ color: 'var(--muted)' }}>
                暂无可用工作流
              </div>
            ) : (
              workflows.map(wf => (
                <div
                  key={wf.name}
                  className="card p-3 space-y-2"
                  style={{
                    borderColor: status?.active && status.name === wf.name ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-xs" style={{ color: 'var(--text)' }}>
                        {wf.name}
                        {wf.source && (
                          <span className="ml-1.5 px-1 py-0.5 rounded text-[10px]" style={{ background: 'var(--surface-hover)', color: 'var(--muted)' }}>
                            {wf.source}
                          </span>
                        )}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
                        {wf.description}
                      </div>
                    </div>
                    {!status?.active && (
                      <button
                        onClick={() => handleActivate(wf.name)}
                        disabled={activating === wf.name}
                        className="btn btn-primary btn-sm flex-shrink-0"
                      >
                        {activating === wf.name ? '激活中...' : '激活'}
                      </button>
                    )}
                  </div>
                  {wf.triggerKeywords && wf.triggerKeywords.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {wf.triggerKeywords.map(kw => (
                        <span
                          key={kw}
                          className="px-1.5 py-0.5 rounded text-[10px]"
                          style={{ background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--border)' }}
                        >
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 图形编辑器视图 */}
      {view === 'editor' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 8 }}>
          {/* 编辑器工具栏 */}
          <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
            <button
              onClick={handleNewGraph}
              className="btn btn-sm"
              style={{ fontSize: 10, padding: '2px 8px' }}
            >
              新建空白
            </button>
            <button
              onClick={handleLoadStarter}
              className="btn btn-sm"
              style={{ fontSize: 10, padding: '2px 8px' }}
            >
              加载示例
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary btn-sm"
              style={{ fontSize: 10, padding: '2px 8px' }}
            >
              {saving ? '保存中...' : '保存'}
            </button>
            <div
              style={{
                flex: 1,
                fontSize: 10,
                color: 'var(--muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 6,
              }}
            >
              <input
                value={graph.metadata?.name ?? ''}
                onChange={e => handleNameChange(e.target.value)}
                placeholder="未命名"
                title="工作流名称（保存时使用）"
                style={{
                  fontSize: 10,
                  padding: '2px 6px',
                  width: 120,
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  borderRadius: 4,
                  textAlign: 'right',
                }}
              />
              <span>· {graph.nodes.length} 节点</span>
            </div>
          </div>

          {/* 编辑器画布 */}
          <div style={{ flex: 1, minHeight: 0, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <WorkflowGraphEditor graph={graph} onGraphChange={setGraph} />
          </div>

          {/* 提示 */}
          <div style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>
            💡 从左侧拖拽节点到画布 · 双击「子工作流」节点进入子图 · 面包屑可返回上层
          </div>
        </div>
      )}
    </div>
  );
}

function StepItem({ step }: { step: WorkflowStepInfo }) {
  const icons: Record<string, string> = {
    pending: '○',
    in_progress: '◐',
    completed: '●',
    blocked: '✕',
  };
  const colors: Record<string, string> = {
    pending: 'var(--muted)',
    in_progress: 'var(--accent)',
    completed: 'var(--success)',
    blocked: 'var(--danger)',
  };

  return (
    <div className="flex items-start gap-2 text-xs">
      <span style={{ color: colors[step.status], lineHeight: '1.4' }}>{icons[step.status]}</span>
      <div className="flex-1 min-w-0">
        <div style={{ color: step.status === 'completed' ? 'var(--muted)' : 'var(--text)' }}>
          {step.id}. {step.name}
        </div>
        {step.reason && (
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--danger)' }}>
            {step.reason}
          </div>
        )}
      </div>
    </div>
  );
}
