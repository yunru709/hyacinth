import { useState } from 'react';

type ScheduleType = 'daily' | 'weekly' | 'none';

interface TaskForm {
  name: string;
  scheduleType: ScheduleType;
  time: string;
}

export function SchedulerPanel() {
  // 后端 Scheduler API 不可用
  const [apiAvailable] = useState(false);

  const [form, setForm] = useState<TaskForm>({
    name: '',
    scheduleType: 'none',
    time: '09:00',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Coming soon — 暂不接后端
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto" style={{minHeight: 0}}>
      {/* API Unavailable Banner */}
      {!apiAvailable && (
        <div className="p-2.5 m-3 rounded-lg text-xs text-center" style={{background: 'var(--warning)', color: '#fff', opacity: 0.9}}>
          ⚠ Scheduler API 当前不可用
        </div>
      )}

      {/* Task List */}
      <div className="p-3 space-y-2 border-b" style={{borderColor: 'var(--border)'}}>
        <div className="text-xs font-semibold uppercase tracking-wide" style={{color: 'var(--muted)'}}>定时任务</div>
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <div className="text-2xl mb-2 opacity-30">📋</div>
          <div className="text-xs" style={{color: 'var(--muted)'}}>暂无定时任务</div>
          <div className="text-[11px] mt-1" style={{color: 'var(--muted)', opacity: 0.7}}>无定时任务</div>
        </div>
      </div>

      {/* New Task Form */}
      <div className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide" style={{color: 'var(--muted)'}}>新建任务</div>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{background: 'var(--warning)', color: '#fff', opacity: 0.8}}>即将推出</span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-[11px]" style={{color: 'var(--text-dim)'}}>任务名称</label>
            <input
              type="text"
              className="input"
              placeholder="例如：每日清理"
              value={form.name}
              onChange={(e) => setForm({...form, name: e.target.value})}
              disabled={!apiAvailable}
              style={{fontSize: 12}}
            />
          </div>

          {/* Schedule Type */}
          <div className="space-y-1">
            <label className="text-[11px]" style={{color: 'var(--text-dim)'}}>调度类型</label>
            <select
              className="input"
              value={form.scheduleType}
              onChange={(e) => setForm({...form, scheduleType: e.target.value as ScheduleType})}
              disabled={!apiAvailable}
              style={{fontSize: 12}}
            >
              <option value="none">选择调度...</option>
              <option value="daily">每日</option>
              <option value="weekly">每周</option>
            </select>
          </div>

          {/* Time */}
          {form.scheduleType !== 'none' && (
            <div className="space-y-1">
              <label className="text-[11px]" style={{color: 'var(--text-dim)'}}>时间</label>
              <input
                type="time"
                className="input"
                value={form.time}
                onChange={(e) => setForm({...form, time: e.target.value})}
                disabled={!apiAvailable}
                style={{fontSize: 12}}
              />
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled
            className="btn btn-primary btn-sm w-full justify-center"
            style={{opacity: 0.5, cursor: 'not-allowed'}}
            title="Coming soon"
          >
            创建任务
          </button>
        </form>
      </div>
    </div>
  );
}