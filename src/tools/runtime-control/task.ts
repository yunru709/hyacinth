import type { Tool } from '../interface.js';
import type { HeartbeatScheduler } from '../../schedule/scheduler.js';
import type { ScheduledTask } from '../../schedule/types.js';

// Schedule task management tools (4)

/**
 * add_task — create a new scheduled task on the HeartbeatScheduler.
 */
export function createAddTaskTool(
  scheduler: HeartbeatScheduler,
  /** 可选：自动检测当前渠道的函数（从 session meta.json 读取） */
  getChannel?: () => string | undefined,
  /** 可选：自动检测当前 sessionId 的函数 */
  getSessionId?: () => string | undefined,
  /** 可选：自动检测当前模式的函数（normal / companion） */
  getMode?: () => 'normal' | 'companion' | undefined,
): Tool {
  return {
    name: 'add_task',
    description:
      '创建新的定时任务。支持 5 种调度类型：\n' +
      '- "interval": 固定间隔触发，如每 5 分钟（intervalMs: 300000）\n' +
      '- "cron": 标准 5 字段 cron，如 "0 3 * * *"（每天凌晨 3 点）\n' +
      '- "daily": 每日定点触发，如 { time: "09:30" }\n' +
      '- "fixed-time": 在指定 ISO 时间单次触发\n' +
      '- "random": 每周期 N 次随机触发，支持时间窗口、可变次数范围和概率权重。如每日 0-5 次、仅 9-18 点、午间权重 3 倍（periodMs: 86400000, countRange: { min: 0, max: 5, distribution: "extremes" }, timeWindow: { start: "09:00", end: "18:00" }, timeWeights: [{ time: "12:00", weight: 3.0 }]）',
    companionDescription: '得记住他刚才说的东西，到时候叫他。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称。' },
        scheduleType: {
          type: 'string',
          enum: ['interval', 'cron', 'daily', 'fixed-time', 'random'],
          description: '调度策略。',
        },
        schedule: {
          type: 'object',
          description: '与所选类型匹配的调度配置。' +
            'interval 示例: { intervalMs: 300000 }。' +
            'cron 示例: { expression: "0 */2 * * *" }。' +
            'daily 示例: { time: "09:00" }。' +
            'fixed-time 示例: { runAt: "2026-06-01T12:00:00.000Z" }。' +
            'random 示例: { periodMs: 86400000, count: 10, minIntervalMs: 300000, timeWindow: { start: "09:00", end: "18:00" }, countRange: { min: 0, max: 5, distribution: "extremes" }, timeWeights: [{ time: "12:00", weight: 3.0 }] }',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选标签，用于分组和筛选（默认 []）。',
        },
        channel: {
          type: 'string',
          description: '任务触发的目标渠道（如 "tui"、"webui"、"feishu"）。不传则自动检测当前会话渠道。',
        },
        fallback: {
          type: 'array',
          items: { type: 'string' },
          description: 'Channel fallback chain when the target channel is offline. E.g. ["webui", "tui"] tries webui first, then tui. If omitted, uses the global default (config.schedule.channelFallback, default: ["feishu"]).',
        },
      },
      required: ['name', 'scheduleType', 'schedule'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const scheduleType = args.scheduleType as string;
      const schedule = args.schedule as Record<string, unknown>;
      const tags = (args.tags as string[]) ?? [];
      // 优先用模型指定的 channel，否则自动检测当前 session 的渠道
      const channel = (args.channel as string | undefined) ?? getChannel?.();
      const fallback = args.fallback as string[] | undefined;

      if (!['interval', 'cron', 'daily', 'fixed-time', 'random'].includes(scheduleType)) {
        return `Error: invalid scheduleType "${scheduleType}". Must be one of: interval, cron, daily, fixed-time, random.`;
      }

      try {
        const task = await scheduler.addTask(
          name,
          scheduleType as ScheduledTask['scheduleType'],
          schedule as unknown as ScheduledTask['schedule'],
          { type: 'callback', target: name },
          tags,
          channel,
          fallback,
        );

        // 自动检测并存储当前 sessionId（多会话渠道如飞书需要此字段来回复到正确的聊天）
        const sessionId = getSessionId?.();
        if (sessionId) {
          task.sessionId = sessionId;
          await scheduler.updateTask(task.id, { sessionId } as any);
        }

        // 自动检测并存储当前模式（正常/陪伴），实现模式间任务隔离
        const mode = getMode?.();
        if (mode) {
          task.mode = mode;
          await scheduler.updateTask(task.id, { mode } as any);
        }

        const nextRun = task.nextRunAt
          ? new Date(task.nextRunAt).toLocaleString()
          : 'N/A';

        const sessionInfo = sessionId ? `\n  Session: ${sessionId}` : '';
        const modeInfo = mode ? `\n  Mode: ${mode}` : '';

        return [
          `Task created: ${task.name} (id: ${task.id})`,
          `  Type: ${task.scheduleType}`,
          `  Channel: ${channel ?? '(auto)'}`,
          `  Next run: ${nextRun}`,
          `  Tags: ${tags.length > 0 ? tags.join(', ') : '(none)'}`,
          sessionInfo,
          modeInfo,
          `\nUse list_tasks to see all tasks, remove_task to delete.`,
        ].filter(Boolean).join('\n');
      } catch (err) {
        return `Error creating task: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * remove_task — delete a scheduled task by id or name.
 */
export function createRemoveTaskTool(
  scheduler: HeartbeatScheduler,
  getMode?: () => 'normal' | 'companion' | undefined,
): Tool {
  return {
    name: 'remove_task',
    description: '删除定时任务。优先按 id 精确删除，找不到时按 name 匹配。先用 list_tasks 确认要删除的任务 ID。',
    companionDescription: '他之前说的那个东西不用管了，不叫了。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id (returned by add_task or list_tasks). Preferred.' },
        name: { type: 'string', description: 'Task name. Falls back to name match if id not provided.' },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const taskId = args.id as string | undefined;
      const taskName = args.name as string | undefined;
      const mode = getMode?.();

      try {
        const findTask = (tasks: ScheduledTask[]) => {
          if (taskId) return tasks.find(t => t.id === taskId);
          if (taskName) return tasks.find(t => t.name === taskName);
          return undefined;
        };

        const tasks = scheduler.getTasks();
        const match = findTask(tasks);
        if (!match) {
          return `Task not found. Use list_tasks to see current tasks.`;
        }

        // 模式隔离：只能删除当前模式（或无模式限制）的任务
        if (mode && match.mode && match.mode !== mode) {
          return `Task "${match.name}" belongs to "${match.mode}" mode. Switch to that mode to delete it.`;
        }

        await scheduler.deleteTask(match.id);
        return `Task "${match.name}" (id: ${match.id}) deleted.`;
      } catch (err) {
        return `Error removing task: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * list_tasks — list all scheduled tasks.
 */
export function createListTasksTool(
  scheduler: HeartbeatScheduler,
  getMode?: () => 'normal' | 'companion' | undefined,
): Tool {
  return {
    name: 'list_tasks',
    description: '列出所有当前已注册的定时任务及其状态。',
    companionDescription: '得回想一下，有哪些需要提醒他的东西。现况如何？',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const mode = getMode?.();
        let tasks = scheduler.getTasks();
        // 按模式过滤：只显示当前模式的任务（或无模式限制的旧任务）
        if (mode) {
          tasks = tasks.filter(t => !t.mode || t.mode === mode);
        }
        if (tasks.length === 0) {
          return 'No scheduled tasks. Use add_task to create one.';
        }

        const lines: string[] = [`=== Scheduled Tasks (${tasks.length}) ===`];
        for (const t of tasks) {
          const nextRun = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : 'N/A';
          const lastRun = t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : 'never';
          const status = t.enabled ? 'enabled' : 'disabled';
          const randomExtra = t.scheduleType === 'random' && t.pendingSlots
            ? ` | slots left: ${t.pendingSlots.length}`
            : '';
          const channelInfo = t.channel ? ` | Channel: ${t.channel}` : '';

          lines.push(
            `\n  ${t.name} (id: ${t.id})`,
            `    Type: ${t.scheduleType} | Status: ${status} | Runs: ${t.runCount} | Errors: ${t.errorCount}${channelInfo}`,
            `    Last: ${lastRun} | Next: ${nextRun}${randomExtra}`,
          );
        }
        lines.push(`\nUse toggle_task to enable/disable, remove_task to delete.`);
        return lines.join('\n');
      } catch (err) {
        return `Error listing tasks: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * toggle_task — enable or disable a scheduled task.
 */
export function createToggleTaskTool(
  scheduler: HeartbeatScheduler,
  getMode?: () => 'normal' | 'companion' | undefined,
): Tool {
  return {
    name: 'toggle_task',
    description: '启用或禁用指定定时任务。禁用后任务保留但不触发。',
    companionDescription: '关于提醒这个事儿，他有别的想法。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id to toggle.' },
        enabled: { type: 'boolean', description: 'True to enable, false to disable.' },
      },
      required: ['id', 'enabled'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const taskId = args.id as string;
      const enabled = args.enabled as boolean;
      const mode = getMode?.();

      try {
        const tasks = scheduler.getTasks();
        const match = tasks.find(t => t.id === taskId);
        if (!match) {
          return `Task "${taskId}" not found. Use list_tasks to see current tasks.`;
        }

        // 模式隔离：只能切换当前模式（或无模式限制）的任务
        if (mode && match.mode && match.mode !== mode) {
          return `Task "${match.name}" belongs to "${match.mode}" mode. Switch to that mode to toggle it.`;
        }

        const ok = enabled
          ? await scheduler.enableTask(taskId)
          : await scheduler.disableTask(taskId);

        return `Task "${taskId}" ${enabled ? 'enabled' : 'disabled'}.`;
      } catch (err) {
        return `Error toggling task: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
