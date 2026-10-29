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
  getMode?: () => string | undefined,
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
    modeDescription: '得记住他刚才说的东西，到时候叫他。',
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
        sessionPolicy: {
          type: 'string',
          enum: ['reuse', 'new'],
          description: '会话策略（默认 reuse）。reuse=触发时在「该任务会话」(task.sessionId) 里跑，会话被关闭也会拉起它；new=每次触发新建一次性临时会话跑完 5 分钟后销毁。',
        },
        channel: {
          type: 'string',
          description: '任务触发的目标渠道（如 "tui"、"webui"、"feishu"）。不传则自动检测当前会话渠道。',
        },
        fallback: {
          type: 'array',
          items: { type: 'string' },
          description: '目标渠道离线时的渠道回退链。如 ["webui", "tui"] 先试 webui，再试 tui。省略时使用全局默认（config.schedule.channelFallback，默认 ["feishu"]）。',
        },
        trigger: {
          type: 'object',
          description:
            '条件触发（2026-10-29 自动化改造）：给了它就**不需要** scheduleType/schedule。\n' +
            '形如 { "type": "condition", "kind": "process", "spec": { "name": "Weixin", "expect": "exit" } }。\n' +
            'kind 可选 file/http/process/port/ui_region；spec 是该 kind 自己的参数。\n' +
            '命中后事件派发到 tool-links 清单（可配 invoke 直接执行工具），本任务自身不唤醒会话。',
          properties: {
            type: { type: 'string', enum: ['condition'] },
            kind: { type: 'string', enum: ['file', 'http', 'process', 'port', 'ui_region'] },
            spec: { type: 'object' },
            intervalMs: { type: 'number', description: '采样间隔（毫秒），默认 2000' },
            cooldownMs: { type: 'number', description: '命中后冷却（毫秒），默认 30000' },
            threshold: { type: 'number' },
            settleFrames: { type: 'number' },
          },
          required: ['type', 'kind', 'spec'],
        },
      },
      // 条件类只需要 name；时间类才需要 scheduleType + schedule（execute 里分别校验）
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const scheduleType = args.scheduleType as string;
      const schedule = args.schedule as Record<string, unknown>;
      const tags = (args.tags as string[]) ?? [];
      // 优先用模型指定的 channel，否则自动检测当前 session 的渠道
      const channel = (args.channel as string | undefined) ?? getChannel?.();
      const fallback = args.fallback as string[] | undefined;

      // ── 条件类（2026-10-29 自动化任务）─────────────────────────────
      // 与时间类完全分开：不需要 scheduleType/schedule，由 WatchService 采样驱动。
      const trigger = args.trigger as
        | { type?: string; kind?: string; spec?: Record<string, unknown> }
        | undefined;
      if (trigger) {
        if (trigger.type !== 'condition') return 'Error: trigger.type must be "condition"';
        if (!trigger.kind) return 'Error: trigger.kind is required';
        try {
          const task = await scheduler.addTask(
            name,
            // 占位类型：条件任务的 calculateNextRun 恒为 null ⇒ 不参与心跳 tick
            'interval',
            { intervalMs: 60_000 } as unknown as ScheduledTask['schedule'],
            { type: 'callback', target: name },
            tags,
            // ⚠️ 故意不传 channel / sessionId：
            // 条件任务命中后只派发 tool-links（如 invoke say），不带 owner ⇒ 不唤醒会话。
            // 若带上，就会「工具执行一次 + 再唤醒一轮对话」⇒ 同一件事做两遍。
            undefined,
            undefined,
            { trigger: trigger as never },
          );
          return [
            `Condition task created: ${task.name} (id: ${task.id})`,
            `  Trigger: ${trigger.kind} ${JSON.stringify(trigger.spec ?? {})}`,
            `  Enabled: ${task.enabled}`,
            '',
            '命中后事件会派发到 tool-links 清单（可配 invoke 直接执行工具）；本任务不唤醒会话。',
            'Use list_tasks to see all tasks, remove_task to delete.',
          ].join('\n');
        } catch (err) {
          return `Error creating condition task: ${(err as Error).message}`;
        }
      }

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
          { reuseByName: false }, // 强制新建（不按 name 复用旧 id，避免"建同名→删旧id 误删新任务"）
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

        // 会话策略（默认 reuse）：决定触发时跑在哪个会话。
        // 新任务显式落该字段 ⇒ handler 走「会话定向路由」；旧任务不带(undefined) ⇒ 保持旧行为。
        const sessionPolicy = (args.sessionPolicy as 'reuse' | 'new' | undefined) ?? 'reuse';
        task.sessionPolicy = sessionPolicy;
        await scheduler.updateTask(task.id, { sessionPolicy } as any);

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
  getMode?: () => string | undefined,
): Tool {
  return {
    name: 'remove_task',
    description: '删除定时任务。优先按 id 精确删除，找不到时按 name 匹配。先用 list_tasks 确认要删除的任务 ID。',
    modeDescription: '他之前说的那个东西不用管了，不叫了。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（由 add_task 或 list_tasks 返回）。优先使用。' },
        name: { type: 'string', description: '任务名。未提供 id 时回退到按名称匹配。' },
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
  getMode?: () => string | undefined,
): Tool {
  return {
    name: 'list_tasks',
    description: '列出所有当前已注册的定时任务及其状态。',
    modeDescription: '得回想一下，有哪些需要提醒他的东西。现况如何？',
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
  getMode?: () => string | undefined,
): Tool {
  return {
    name: 'toggle_task',
    description: '启用或禁用指定定时任务。禁用后任务保留但不触发。',
    modeDescription: '关于提醒这个事儿，他有别的想法。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要切换的任务 id。' },
        enabled: { type: 'boolean', description: 'true 启用，false 禁用。' },
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
