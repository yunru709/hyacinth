import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { ScheduledTask, TaskExecutionRecord } from '../types';
import { EmptyState, LoadingState, ErrorState } from './ui/PanelStates';

export function SchedulerPanel() {
  const schedulerStatus = useStore(s => s.schedulerStatus);
  const schedulerTasks = useStore(s => s.schedulerTasks);
  const schedulerRecords = useStore(s => s.schedulerRecords);
  const schedulerLoading = useStore(s => s.schedulerLoading);
  const schedulerStatusError = useStore(s => s.schedulerStatusError);
  const schedulerTasksError = useStore(s => s.schedulerTasksError);
  const schedulerRecordsError = useStore(s => s.schedulerRecordsError);
  const fetchSchedulerStatus = useStore(s => s.fetchSchedulerStatus);
  const fetchSchedulerTasks = useStore(s => s.fetchSchedulerTasks);
  const fetchSchedulerRecords = useStore(s => s.fetchSchedulerRecords);
  const addSchedulerTask = useStore(s => s.addSchedulerTask);
  const deleteSchedulerTask = useStore(s => s.deleteSchedulerTask);
  const toggleSchedulerTask = useStore(s => s.toggleSchedulerTask);

  const [name, setName] = useState('');
  const [time, setTime] = useState('09:00');

  useEffect(() => {
    fetchSchedulerStatus();
    fetchSchedulerTasks();
    fetchSchedulerRecords();
  }, [fetchSchedulerStatus, fetchSchedulerTasks, fetchSchedulerRecords]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const ok = await addSchedulerTask(trimmed, time);
    if (ok) {
      setName('');
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto" style={{ minHeight: 0 }}>
      {/* Status */}
      <div className="p-3 space-y-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>调度器状态</div>
          <button
            onClick={() => { fetchSchedulerStatus(); fetchSchedulerTasks(); fetchSchedulerRecords(); }}
            disabled={schedulerLoading}
            className="btn btn-sm btn-ghost"
            style={{ color: 'var(--muted)' }}
          >
            ↻ 刷新
          </button>
        </div>
        {schedulerStatusError && <ErrorState error={schedulerStatusError} onRetry={fetchSchedulerStatus} />}
        {!schedulerStatusError && schedulerLoading && !schedulerStatus && <LoadingState text="加载状态中..." />}
        {!schedulerStatusError && schedulerStatus && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex justify-between">
              <span style={{ color: 'var(--muted)' }}>运行中</span>
              <span style={{ color: schedulerStatus.running ? 'var(--success)' : 'var(--danger)' }}>
                {schedulerStatus.running ? '是' : '否'}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--muted)' }}>任务数</span>
              <span>{schedulerStatus.taskCount}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--muted)' }}>已启用</span>
              <span>{schedulerStatus.enabledTaskCount}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--muted)' }}>运行时长</span>
              <span>{schedulerStatus.uptime != null ? `${schedulerStatus.uptime}s` : 'N/A'}</span>
            </div>
          </div>
        )}
      </div>

      {/* New Task */}
      <div className="p-3 space-y-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>新建定时任务</div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-[11px]" style={{ color: 'var(--text-dim)' }}>任务名称</label>
            <input
              type="text"
              className="input"
              placeholder="例如：每日清理"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={schedulerLoading}
              style={{ fontSize: 12 }}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px]" style={{ color: 'var(--text-dim)' }}>执行时间（HH:mm）</label>
            <input
              type="time"
              className="input"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              disabled={schedulerLoading}
              style={{ fontSize: 12 }}
            />
          </div>
          <button
            type="submit"
            disabled={schedulerLoading || !name.trim()}
            className="btn btn-primary btn-sm w-full justify-center"
          >
            {schedulerLoading ? '创建中...' : '创建任务'}
          </button>
        </form>
      </div>

      {/* Task List */}
      <div className="p-3 space-y-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>任务列表</div>
        {schedulerTasksError && <ErrorState error={schedulerTasksError} onRetry={fetchSchedulerTasks} />}
        {!schedulerTasksError && schedulerTasks.length === 0 ? (
          <EmptyState icon="📋" text="暂无定时任务" hint="在上方创建新任务" />
        ) : (
          <div className="space-y-2">
            {schedulerTasks.map((task: ScheduledTask) => (
              <TaskCard
                key={task.id}
                task={task}
                onToggle={() => toggleSchedulerTask(task.id, task.enabled)}
                onDelete={() => deleteSchedulerTask(task.id)}
                disabled={schedulerLoading}
              />
            ))}
          </div>
        )}
      </div>

      {/* Records */}
      <div className="p-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>最近执行记录</div>
        {schedulerRecordsError && <ErrorState error={schedulerRecordsError} onRetry={fetchSchedulerRecords} />}
        {!schedulerRecordsError && schedulerRecords.length === 0 ? (
          <EmptyState icon="📜" text="暂无记录" hint="任务执行后将显示在这里" />
        ) : (
          <div className="space-y-1.5">
            {schedulerRecords.map((record: TaskExecutionRecord, i: number) => (
              <div key={`${record.taskId}-${i}`} className="flex items-center justify-between text-xs px-2 py-1.5 rounded border" style={{ borderColor: 'var(--border)' }}>
                <div className="truncate flex-1" style={{ color: 'var(--text)' }}>
                  {record.taskName}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                    {new Date(record.executedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: record.success ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      color: record.success ? 'var(--success)' : 'var(--danger)',
                    }}
                  >
                    {record.success ? '成功' : '失败'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  onToggle,
  onDelete,
  disabled,
}: {
  task: ScheduledTask;
  onToggle: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN') : 'N/A';
  const lastRun = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString('zh-CN') : '从未';
  const scheduleText = formatSchedule(task);

  return (
    <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="font-medium" style={{ color: 'var(--text)' }}>{task.name}</span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{
              background: task.enabled ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)',
              color: task.enabled ? 'var(--success)' : 'var(--muted)',
            }}
          >
            {task.enabled ? '启用' : '禁用'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggle}
            disabled={disabled}
            className="px-2 py-1 rounded text-[10px] hover:opacity-80 min-w-[2rem]"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {task.enabled ? '禁用' : '启用'}
          </button>
          <button
            onClick={onDelete}
            disabled={disabled}
            className="px-2 py-1 rounded text-[10px] hover:opacity-80 min-w-[2rem]"
            style={{ background: 'var(--danger)', color: '#fff' }}
          >
            删除
          </button>
        </div>
      </div>
      <div className="space-y-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>
        <div>类型: {task.scheduleType} · {scheduleText}</div>
        <div>下次运行: {nextRun}</div>
        <div>上次运行: {lastRun} · 累计 {task.runCount} 次 · 失败 {task.errorCount} 次</div>
      </div>
    </div>
  );
}

function formatSchedule(task: ScheduledTask): string {
  if (task.scheduleType === 'daily') {
    return `每天 ${(task.schedule as { time?: string }).time ?? '?'}`;
  }
  if (task.scheduleType === 'interval') {
    return `每 ${(task.schedule as { intervalMs?: number }).intervalMs ?? '?'} 毫秒`;
  }
  if (task.scheduleType === 'cron') {
    return `cron: ${(task.schedule as { expression?: string }).expression ?? '?'}`;
  }
  if (task.scheduleType === 'fixed-time') {
    return `一次性: ${(task.schedule as { runAt?: string }).runAt ?? '?'}`;
  }
  if (task.scheduleType === 'random') {
    return `随机: ${(task.schedule as { count?: number }).count ?? '?'} 次/周期`;
  }
  return '';
}
