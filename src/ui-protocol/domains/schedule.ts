// ============================================================
// UI 协议层 — 调度域（schedule.*）
// ============================================================
// 覆盖 UI 对调度任务的读取（对应 TUI /schedule 用
// loop.getScheduler().getTasks() 展示真实任务）：
//   schedule.list   列出所有调度任务（含运行状态）
//
// 依赖结构化 SchedulerLike 接口（真实 HeartbeatScheduler 天然
// 兼容：getTasks/getStatus），保证协议层可独立测试、可替换实现。
// ============================================================

import type { DomainHandler } from '../server.js';
import type { ScheduledTaskLike } from '../types.js';
import type { LoopLike } from './state.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实 HeartbeatScheduler 兼容）
// ────────────────────────────────────────────────────────────

/** 调度器状态（对应 SchedulerStatus） */
export interface SchedulerStatusLike {
  running: boolean;
  startedAt?: string | null;
  taskCount: number;
  enabledTaskCount: number;
  uptime?: number | null;
}

/** 最小调度器视图（对应 HeartbeatScheduler 的公开查询方法） */
export interface SchedulerLike {
  getTasks(): ScheduledTaskLike[];
  getStatus?(): SchedulerStatusLike;
  // ── 写操作（对应 HeartbeatScheduler；协议层缺省 mock 可不实现）──
  addTask?(
    name: string,
    scheduleType: string,
    schedule: Record<string, unknown>,
    action: { type: string; target: string; payload?: Record<string, unknown> },
    tags?: string[],
    channel?: string,
    fallback?: string[],
  ): Promise<unknown>;
  deleteTask?(taskId: string): Promise<boolean>;
  enableTask?(taskId: string): Promise<boolean>;
  disableTask?(taskId: string): Promise<boolean>;
}

// ────────────────────────────────────────────────────────────
// 调度域选项
// ────────────────────────────────────────────────────────────

export interface ScheduleDomainOptions {
  /** 动态获取调度器（loop 在 initialize 后才就绪，通过闭包延迟解析） */
  getScheduler: () => SchedulerLike | null;
  /** 动态获取 AgentLoop（schedule.runtime 用：读取 pendingTaskName）。可选。 */
  getLoop?: () => LoopLike | null;
}

// ────────────────────────────────────────────────────────────
// 调度域工厂
// ────────────────────────────────────────────────────────────

export function createScheduleDomain(options: ScheduleDomainOptions): DomainHandler {
  const { getScheduler, getLoop } = options;

  /** 取调度器，不存在时抛错 */
  function requireScheduler(): SchedulerLike {
    const scheduler = getScheduler();
    if (!scheduler) throw new Error('scheduler not available');
    return scheduler;
  }

  return {
    // ── schedule.list ─────────────────────────────────────
    list(): { tasks: ScheduledTaskLike[]; status?: SchedulerStatusLike } {
      const scheduler = getScheduler();
      if (!scheduler) return { tasks: [] };
      return {
        tasks: scheduler.getTasks(),
        status: scheduler.getStatus?.(),
      };
    },

    // ── schedule.add ──────────────────────────────────────
    async add(params: unknown): Promise<{ ok: true }> {
      const { name, scheduleType, schedule, action, tags, channel, fallback } = (params ?? {}) as {
        name?: string;
        scheduleType?: string;
        schedule?: Record<string, unknown>;
        action?: { type: string; target: string; payload?: Record<string, unknown> };
        tags?: string[];
        channel?: string;
        fallback?: string[];
      };
      if (!name || !scheduleType || !schedule || !action) {
        throw new Error('schedule.add requires "name", "scheduleType", "schedule", "action"');
      }
      const scheduler = requireScheduler();
      if (!scheduler.addTask) throw new Error('addTask not supported by scheduler');
      await scheduler.addTask(name, scheduleType, schedule, action, tags, channel, fallback);
      return { ok: true };
    },

    // ── schedule.remove ───────────────────────────────────
    async remove(params: unknown): Promise<{ ok: boolean }> {
      const id = (params as { id?: string } | undefined)?.id;
      if (!id) throw new Error('schedule.remove requires "id"');
      const scheduler = requireScheduler();
      if (!scheduler.deleteTask) throw new Error('deleteTask not supported by scheduler');
      const removed = await scheduler.deleteTask(id);
      return { ok: removed };
    },

    // ── schedule.addDaily ──────────────────────────────────
    // 便捷：每日定点任务（对应 TUI /schedule-add <name> <HH:mm> →
    // loop.addScheduledTask(name, 'daily', time) 的等价语义）。
    async addDaily(params: unknown): Promise<{ ok: true }> {
      const { name, time } = (params ?? {}) as { name?: string; time?: string };
      if (!name || !time) {
        throw new Error('schedule.addDaily requires "name" and "time" (HH:mm)');
      }
      const scheduler = requireScheduler();
      if (!scheduler.addTask) throw new Error('addTask not supported by scheduler');
      await scheduler.addTask(
        name,
        'daily',
        { time },
        { type: 'scheduled', target: name, payload: {} },
        [],
      );
      return { ok: true };
    },

    // ── schedule.runtime ───────────────────────────────────
    // 调度运行时状态：当前正在执行的任务名（对应 TUI 状态栏
    // loop.pendingTaskName；WebUI 状态栏同步用）。
    runtime(): { pendingTaskName: string | null } {
      const loop = getLoop?.() ?? null;
      return { pendingTaskName: loop?.pendingTaskName ?? null };
    },

    // ── schedule.toggle ───────────────────────────────────
    async toggle(params: unknown): Promise<{ ok: boolean; enabled: boolean }> {
      const { id, enabled } = (params ?? {}) as { id?: string; enabled?: boolean };
      if (!id || enabled === undefined) {
        throw new Error('schedule.toggle requires "id" and "enabled"');
      }
      const scheduler = requireScheduler();
      if (enabled) {
        if (!scheduler.enableTask) throw new Error('enableTask not supported by scheduler');
        const ok = await scheduler.enableTask(id);
        return { ok, enabled: true };
      }
      if (!scheduler.disableTask) throw new Error('disableTask not supported by scheduler');
      const ok = await scheduler.disableTask(id);
      return { ok, enabled: false };
    },
  };
}
