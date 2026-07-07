import crypto from 'node:crypto';
import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ScheduledTask,
  ScheduleConfig,
  ScheduleType,
  IntervalConfig,
  DailyConfig,
  FixedTimeConfig,
  TaskAction,
  TaskExecutionRecord,
  SchedulerConfig,
  SchedulerStatus,
} from './types.js';
import type { ScheduleConfig as SystemScheduleConfig } from '../setup/config.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { CronExpression } from './cron.js';
import { SchedulePersistence } from './persistence.js';

const DEFAULT_CONFIG: SchedulerConfig = {
  heartbeatMs: 5000,
  maxConcurrent: 10,
  taskTimeoutMs: 300_000,
  maxRecords: 1000,
  /** 全局默认降级链：后端可脱离任何渠道独立运行，飞书作为持久消息渠道兜底 */
  channelFallback: ['feishu'],
};

/** 任务执行处理器 */
export type TaskHandler = (task: ScheduledTask) => Promise<void>;

/**
 * HeartbeatScheduler — 心跳驱动的定时任务调度器。
 *
 * 职责：
 *   1. 以固定间隔（heartbeat）检查到期任务
 *   2. 支持 interval / cron / daily / fixed-time 四种调度类型
 *   3. 计算下次执行时间，持久化任务状态
 *   4. 通过 TaskHandler 回调执行任务
 *   5. 记录执行历史
 */
export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt: Date | null = null;
  private running = false;
  private activeCount = 0;
  private handler: TaskHandler | null = null;
  private config: SchedulerConfig;
  private persistence: SchedulePersistence;
  private tasks: ScheduledTask[] = [];
  private configUnsubscribers: Array<() => void> = [];
  /** tasks.json 上次加载时的 mtime（毫秒），用于跨实例同步检测 */
  private lastLoadMtime = 0;
  private readonly storagePath = path.join(os.homedir(), '.agent', 'scheduler', 'tasks.json');

  constructor(config?: Partial<SchedulerConfig>, scheduleConfig?: SystemScheduleConfig) {
    this.config = { ...DEFAULT_CONFIG, ...(scheduleConfig ?? {}), ...config };
    this.persistence = new SchedulePersistence();
  }

  /** 注册任务执行处理器 */
  setHandler(handler: TaskHandler): void {
    this.handler = handler;
  }

  /** 获取调度器状态 */
  getStatus(): SchedulerStatus {
    return {
      running: this.running,
      startedAt: this.startedAt?.toISOString() ?? null,
      taskCount: this.tasks.length,
      enabledTaskCount: this.tasks.filter(t => t.enabled).length,
      recentExecutions: [], // records are loaded on demand
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : null,
    };
  }

  /**
   * Subscribe to RuntimeConfigCenter for dynamic reconfiguration.
   *
   * Watched paths:
   *   - schedule.heartbeatMs   — restarts the heartbeat timer on change
   *   - schedule.maxConcurrent — live-updates the concurrency limit
   *   - schedule.taskTimeoutMs — live-updates per-task timeout
   *   - schedule.maxRecords    — live-updates execution record cap
   */
  subscribeConfig(configCenter: RuntimeConfigCenter): void {
    this.configUnsubscribers.push(
      configCenter.watch('schedule.heartbeatMs', (event) => {
        if (typeof event.newValue === 'number' && event.newValue > 0) {
          this.config.heartbeatMs = event.newValue;
          this.restartHeartbeat();
        }
      }),
    );

    this.configUnsubscribers.push(
      configCenter.watch('schedule.maxConcurrent', (event) => {
        if (typeof event.newValue === 'number' && event.newValue > 0) {
          this.config.maxConcurrent = event.newValue;
        }
      }),
    );

    this.configUnsubscribers.push(
      configCenter.watch('schedule.taskTimeoutMs', (event) => {
        if (typeof event.newValue === 'number' && event.newValue > 0) {
          this.config.taskTimeoutMs = event.newValue;
        }
      }),
    );

    this.configUnsubscribers.push(
      configCenter.watch('schedule.maxRecords', (event) => {
        if (typeof event.newValue === 'number' && event.newValue > 0) {
          this.config.maxRecords = event.newValue;
        }
      }),
    );
  }

  /** 启动调度器 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date();

    this.tasks = await this.persistence.getAllTasks();
    this.refreshMtime();

    const now = new Date();
    let cleaned = 0;

    // 去重：同名任务只保留最新的一条，其余从内存和磁盘中删除
    const seen = new Map<string, ScheduledTask>();
    const duplicates: ScheduledTask[] = [];
    for (const task of this.tasks) {
      const existing = seen.get(task.name);
      if (existing) {
        const keep = existing.createdAt && task.createdAt
          ? (existing.createdAt > task.createdAt ? existing : task)
          : existing;
        const remove = keep === existing ? task : existing;
        duplicates.push(remove);
        seen.set(task.name, keep);
      } else {
        seen.set(task.name, task);
      }
    }
    if (duplicates.length > 0) {
      for (const dup of duplicates) {
        this.persistence.deleteTask(dup.id).catch(() => {});
        cleaned++;
      }
    }

    this.tasks = this.tasks.filter((task) => {
      if (task.scheduleType === 'fixed-time' && task.nextRunAt !== null) {
        const runAt = new Date(task.nextRunAt);
        if (runAt < now) {
          this.persistence.deleteTask(task.id).catch(() => {});
          cleaned++;
          return false;
        }
      }
      // 同时也去掉重名重复项
      if (duplicates.includes(task)) {
        return false;
      }
      return true;
    });

    // 找出到期但从未执行过的任务（离线错过），重算前先记录
    const MISSED_CATCH_UP_GAP_MS = 30 * 60_000; // 30 分钟：正常下次执行在半小时内就不补了
    const missedTasks = this.tasks.filter(
      t => t.enabled && t.scheduleType !== 'fixed-time' && t.scheduleType !== 'random'
        && t.nextRunAt && new Date(t.nextRunAt) < now && t.lastRunAt === null,
    );

    for (const task of this.tasks) {
      if (task.enabled) {
        task.nextRunAt = this.calculateNextRun(task)?.toISOString() ?? null;
      }
    }

    // 筛选：正常重算后的下次执行时间如果很近，就不补（避免 2:50 补一次、3:00 又跑一次）
    const catchUpTasks = missedTasks.filter(t => {
      if (!t.nextRunAt) return false;
      const nextMs = new Date(t.nextRunAt).getTime() - Date.now();
      return nextMs > MISSED_CATCH_UP_GAP_MS;
    });

    // 启动心跳循环
    this.timer = setInterval(() => this.tick(), this.config.heartbeatMs);
    // 立即执行一次 tick
    setImmediate(() => this.tick());

    // 补执行离线期间错过的到期任务（每条只补一次）
    if (catchUpTasks.length > 0) {
      console.log(`[HeartbeatScheduler] Catch-up: ${catchUpTasks.length} missed task(s)`);
      for (const task of catchUpTasks) {
        this.executeTask(task);
      }
    }
  }

  /** 停止调度器 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 等待进行中的任务完成（最多等 5 秒）
    const maxWait = 5000;
    const start = Date.now();
    while (this.activeCount > 0 && Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 100));
    }
    this.startedAt = null;
  }

  // ===== 任务管理 =====

  /** 添加新任务（同名任务会自动更新而非新增） */
  async addTask(
    name: string,
    scheduleType: ScheduleType,
    schedule: ScheduleConfig,
    action: TaskAction,
    tags: string[] = [],
    channel?: string,
    fallback?: string[],
  ): Promise<ScheduledTask> {
    const existing = this.tasks.find(t => t.name === name);
    if (existing) {
      existing.scheduleType = scheduleType;
      existing.schedule = schedule;
      existing.action = action;
      existing.tags = tags;
      existing.channel = channel ?? existing.channel;
      existing.fallback = fallback ?? existing.fallback;
      existing.enabled = true;
      existing.nextRunAt = this.calculateNextRun(existing)?.toISOString() ?? null;
      await this.persistence.saveTask(existing);
      return existing;
    }

    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      name,
      scheduleType,
      schedule,
      action,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      errorCount: 0,
      tags,
      channel,
      fallback,
    };

    task.nextRunAt = this.calculateNextRun(task)?.toISOString() ?? null;
    this.tasks.push(task);
    await this.persistence.saveTask(task);
    return task;
  }

  /** 更新任务 */
  async updateTask(taskId: string, updates: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return null;

    Object.assign(task, updates);

    // 如果调度配置变了，重新计算 nextRunAt
    if (updates.schedule || updates.enabled !== undefined) {
      task.nextRunAt = task.enabled ? this.calculateNextRun(task)?.toISOString() ?? null : null;
    }

    await this.persistence.saveTask(task);
    return task;
  }

  /** 删除任务 */
  async deleteTask(taskId: string): Promise<boolean> {
    const idx = this.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return false;
    this.tasks.splice(idx, 1);
    await this.persistence.deleteTask(taskId);
    return true;
  }

  /** 获取所有任务 */
  /** 刷新 mtime 追踪（在 tasks 数据从磁盘加载后调用） */
  private refreshMtime(): void {
    try {
      const stat = statSync(this.storagePath);
      this.lastLoadMtime = stat.mtimeMs;
    } catch { /* 文件不存在 */ }
  }

  /**
   * 获取所有任务。
   * 每次调用时检查 tasks.json 是否被其他实例修改（跨渠道同步），
   * 若有变更则自动从磁盘重新加载。
   */
  getTasks(): ScheduledTask[] {
    try {
      if (existsSync(this.storagePath)) {
        const stat = statSync(this.storagePath);
        if (stat.mtimeMs > this.lastLoadMtime) {
          const raw = readFileSync(this.storagePath, 'utf-8');
          const data = JSON.parse(raw);
          if (Array.isArray(data.tasks)) {
            this.tasks = data.tasks;
          } else if (Array.isArray(data)) {
            this.tasks = data;
          }
          this.lastLoadMtime = stat.mtimeMs;
        }
      }
    } catch { /* 读取失败用内存缓存 */ }
    return [...this.tasks];
  }

  /** 获取单个任务 */
  getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.find(t => t.id === taskId);
  }

  /** 启用任务 */
  async enableTask(taskId: string): Promise<boolean> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return false;
    task.enabled = true;
    task.nextRunAt = this.calculateNextRun(task)?.toISOString() ?? null;
    await this.persistence.saveTask(task);
    return true;
  }

  /** 禁用任务 */
  async disableTask(taskId: string): Promise<boolean> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return false;
    task.enabled = false;
    task.nextRunAt = null;
    await this.persistence.saveTask(task);
    return true;
  }

  /** 获取执行记录 */
  async getRecentRecords(limit?: number): Promise<TaskExecutionRecord[]> {
    return this.persistence.getRecentRecords(limit);
  }

  // ===== 内部方法 =====

  /** 心跳 tick */
  private async tick(): Promise<void> {
    if (!this.running) return;

    const now = new Date();
    const dueTasks = this.tasks.filter(t => {
      if (!t.enabled || !t.nextRunAt) return false;
      return new Date(t.nextRunAt) <= now;
    });

    for (const task of dueTasks) {
      if (this.activeCount >= this.config.maxConcurrent) break;
      this.executeTask(task);
    }
  }

  /**
   * Restart the heartbeat interval with the current config.heartbeatMs.
   * No-op when the scheduler is not running.
   */
  private restartHeartbeat(): void {
    if (!this.running) return;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => this.tick(), this.config.heartbeatMs);
  }

  /** 执行单个任务 */
  private async executeTask(task: ScheduledTask): Promise<void> {
    this.activeCount++;
    const startTime = Date.now();

    const record: TaskExecutionRecord = {
      taskId: task.id,
      taskName: task.name,
      executedAt: new Date().toISOString(),
      durationMs: 0,
      success: false,
    };

    try {
      // 超时控制
      const result = await Promise.race([
        this.runHandler(task),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Task timeout')), this.config.taskTimeoutMs)
        ),
      ]);

      record.durationMs = Date.now() - startTime;
      record.success = true;

      task.runCount++;
      task.lastRunAt = record.executedAt;
    } catch (err) {
      record.durationMs = Date.now() - startTime;
      record.success = false;
      record.error = err instanceof Error ? err.message : String(err);

      task.errorCount++;
      task.lastRunAt = record.executedAt;
    } finally {
      this.activeCount--;
    }

    // random 类型：先消费已执行的 slot，再计算下次执行时间
    // 注意顺序：必须 shift 在 calculateNextRun 之前，否则 calculateNextRun
    // 会基于尚未消费的 slot 计算，导致同一 slot 被重复触发一次。
    if (task.scheduleType === 'random' && task.pendingSlots && task.pendingSlots.length > 0) {
      task.pendingSlots.shift();
      if (task.pendingSlots.length === 0) {
        // 本周期所有 slot 已用完，下次 calculateNextRun 会滚动到新周期
        task.pendingSlots = undefined;
      }
    }

    // 计算下次执行时间
    task.nextRunAt = this.calculateNextRun(task)?.toISOString() ?? null;

    // 持久化
    await this.persistence.saveTask(task);
    await this.persistence.addRecord(record, this.config.maxRecords);
  }

  /** 调用注册的处理器 */
  private async runHandler(task: ScheduledTask): Promise<void> {
    if (!this.handler) return;
    await this.handler(task);
  }

  /** 计算下次执行时间 */
  private calculateNextRun(task: ScheduledTask): Date | null {
    const now = new Date();
    // 如果之前执行过，从 lastRunAt 之后算；否则从当前时间算
    const from = task.lastRunAt ? new Date(task.lastRunAt) : now;

    switch (task.scheduleType) {
      case 'interval': {
        const cfg = task.schedule as IntervalConfig;
        const next = new Date(from.getTime() + cfg.intervalMs);
        return next <= now ? new Date(now.getTime() + cfg.intervalMs) : next;
      }

      case 'cron': {
        const cfg = task.schedule as { expression: string };
        try {
          const cron = new CronExpression(cfg.expression);
          return cron.next(now);
        } catch {
          return null;
        }
      }

      case 'daily': {
        const cfg = task.schedule as DailyConfig;
        const [h, m] = cfg.time.split(':').map(Number);
        if (isNaN(h) || isNaN(m)) return null;

        const next = new Date(now);
        next.setHours(h, m, 0, 0);

        if (next <= now) {
          next.setDate(next.getDate() + 1);
        }
        return next;
      }

      case 'fixed-time': {
        const cfg = task.schedule as FixedTimeConfig;
        const target = new Date(cfg.runAt);
        return target > now ? target : null; // 一次性任务，过期后不再执行
      }

      case 'random': {
        const cfg = task.schedule as import('./types.js').RandomConfig;
        const minInterval = cfg.minIntervalMs ?? 0;

        // 确定当前周期起始点
        let periodStart: Date;
        if (task.periodStartAt) {
          periodStart = new Date(task.periodStartAt);
        } else {
          // 第一个周期从 now 开始
          const nowMs = now.getTime();
          periodStart = new Date(nowMs);
          task.periodStartAt = periodStart.toISOString();
        }

        // 检查是否进入新周期：当前周期结束，重新生成 slot
        const periodEnd = new Date(periodStart.getTime() + cfg.periodMs);
        if (now >= periodEnd) {
          // 滚动到新周期（基于原周期结束点对齐）
          const elapsedPeriods = Math.floor(
            (now.getTime() - periodStart.getTime()) / cfg.periodMs,
          );
          periodStart = new Date(periodStart.getTime() + elapsedPeriods * cfg.periodMs);
          task.periodStartAt = periodStart.toISOString();
          task.pendingSlots = undefined; // 清空旧 slots，触发重新生成
        }

        // 如果没有已生成的 slot，生成新的一组
        if (!task.pendingSlots || task.pendingSlots.length === 0) {
          task.pendingSlots = generateRandomSlots(cfg, periodStart, minInterval);
        }

        // 本周期没有有效 slot（count=0 或时间窗口为空），跳到下一周期
        if (task.pendingSlots.length === 0) {
          const nextPeriod = new Date(periodStart.getTime() + cfg.periodMs);
          task.periodStartAt = nextPeriod.toISOString();
          task.pendingSlots = undefined;
          return nextPeriod;
        }

        // 找到第一个未过期的 slot
        let nextSlot: Date | null = null;
        while (task.pendingSlots.length > 0) {
          const candidate = new Date(task.pendingSlots[0]);
          if (candidate > now) {
            nextSlot = candidate;
            break;
          }
          // slot 已过期，丢弃
          task.pendingSlots.shift();
        }

        // 所有 slot 都过期了 → 跳到下一周期
        if (!nextSlot) {
          const nextPeriod = new Date(periodStart.getTime() + cfg.periodMs);
          task.periodStartAt = nextPeriod.toISOString();
          task.pendingSlots = undefined;
          return nextPeriod;
        }

        return nextSlot;
      }

      default:
        return null;
    }
  }
}

/**
 * 在 periodMs 周期窗口内生成 count 个随机时间点，按升序排列。
 *
 * 约束：
 *  - slots 在 [periodStart, periodStart + periodMs) 区间内
 *  - 相邻 slot 间隔 >= minIntervalMs
 *  - 总数不超过 count
 */
/** 解析 "HH:mm" → 一天内的毫秒偏移 */
function parseTimeOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h * 60 + m) * 60 * 1000;
}

/** 按分布从 [min, max] 中随机选一个整数 */
function pickCountFromRange(range: import('./types.js').CountRange): number {
  const { min, max, distribution = 'uniform' } = range;
  if (min >= max) return min;

  if (distribution === 'extremes') {
    // U 形：40% 概率选 min，40% 选 max，20% 均匀分布在中间
    const r = Math.random();
    if (r < 0.4) return min;
    if (r < 0.8) return max;
    return min + 1 + Math.floor(Math.random() * (max - min - 1));
  }

  // uniform
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 构建时间权重插值函数。
 * 给定控制点数组 [{time, weight}]，返回 (msOffset) → weight 的线性插值函数。
 * msOffset = 从 effectiveStart 起的毫秒数。
 */
function buildWeightInterpolator(
  weights: import('./types.js').TimeWeight[],
  effectiveStart: number,
  windowMs: number,
): (msOffset: number) => number {
  // 按权重值排序控制点，转为 (offset, weight) 对
  const points = weights
    .map(w => ({ offset: parseTimeOfDay(w.time), weight: w.weight }))
    .sort((a, b) => a.offset - b.offset);

  // 把控制点映射到窗口内的偏移
  const windowStartOfDay = effectiveStart % 86400000;
  const mapped = points.map(p => ({
    offset: ((p.offset - windowStartOfDay + 86400000) % 86400000),
    weight: p.weight,
  }));

  return (msOffset: number): number => {
    // 找到 msOffset 落在哪两个控制点之间
    const t = msOffset % 86400000;
    // 找左右控制点
    let left = mapped[mapped.length - 1];  // wrap: last point
    let right = mapped[0];
    for (let i = 0; i < mapped.length; i++) {
      if (mapped[i].offset <= t) {
        left = mapped[i];
        right = mapped[(i + 1) % mapped.length];
      }
    }

    let rightOffset = right.offset;
    if (rightOffset <= left.offset) rightOffset += 86400000;
    let tAdjusted = t;
    if (tAdjusted < left.offset) tAdjusted += 86400000;

    const fraction = (tAdjusted - left.offset) / (rightOffset - left.offset);
    return left.weight + fraction * (right.weight - left.weight);
  };
}

function generateRandomSlots(
  cfg: import('./types.js').RandomConfig,
  periodStart: Date,
  minInterval: number,
): string[] {
  const periodStartMs = periodStart.getTime();
  const periodEndMs = periodStartMs + cfg.periodMs;

  // ── 确定触发次数 ──
  const count = cfg.countRange
    ? pickCountFromRange(cfg.countRange)
    : cfg.count;
  if (count <= 0) return []; // 本周期不触发

  // ── 时间窗口计算 ──
  let effectiveStart = periodStartMs;
  let effectiveEnd = periodEndMs;

  if (cfg.timeWindow) {
    const twStart = parseTimeOfDay(cfg.timeWindow.start);
    const twEnd = parseTimeOfDay(cfg.timeWindow.end);

    if (twEnd > twStart) {
      const dayStart = new Date(periodStartMs);
      dayStart.setHours(0, 0, 0, 0);
      const dayStartMs = dayStart.getTime();

      let candidateStart = dayStartMs + twStart;
      while (candidateStart < periodStartMs) {
        candidateStart += 86400000;
      }
      const candidateEnd = candidateStart + (twEnd - twStart);

      effectiveStart = Math.max(periodStartMs, candidateStart);
      effectiveEnd = Math.min(periodEndMs, candidateEnd);
    } else {
      const dayStart = new Date(periodStartMs);
      dayStart.setHours(0, 0, 0, 0);
      const dayStartMs = dayStart.getTime();

      let windowStart = dayStartMs - 86400000 + twStart;
      let windowEnd = dayStartMs + twEnd;
      while (windowEnd <= periodStartMs) {
        windowStart += 86400000;
        windowEnd += 86400000;
      }

      effectiveStart = Math.max(periodStartMs, windowStart);
      effectiveEnd = Math.min(periodEndMs, windowEnd);
    }
  }

  const windowMs = effectiveEnd - effectiveStart;
  if (windowMs <= 0) return [];

  // ── 时间权重插值器 ──
  const weightFn = cfg.timeWeights && cfg.timeWeights.length > 0
    ? buildWeightInterpolator(cfg.timeWeights, effectiveStart, windowMs)
    : null;
  const maxWeight = weightFn
    ? Math.max(...cfg.timeWeights!.map(w => w.weight))
    : 1;

  // 若窗口太小放不下 count 个 slot，降级为均匀分布
  if (count * minInterval > windowMs) {
    const step = windowMs / (count + 1);
    const slots: string[] = [];
    for (let i = 1; i <= count; i++) {
      slots.push(new Date(effectiveStart + Math.round(step * i)).toISOString());
    }
    return slots;
  }

  // ── 带权重拒绝采样的随机偏移生成 ──
  const offsets: number[] = [];
  const attempts = count * 40; // 带权重需要更多尝试
  for (let i = 0; i < attempts && offsets.length < count; i++) {
    const offset = effectiveStart + Math.random() * windowMs;
    // 检查间隔
    const tooClose = offsets.some(o => Math.abs(offset - o) < minInterval);
    if (tooClose) continue;
    // 权重拒绝采样
    if (weightFn) {
      const w = weightFn(offset - effectiveStart);
      if (Math.random() > w / maxWeight) continue; // 拒绝
    }
    offsets.push(offset);
  }

  // 排序后转 ISO 字符串
  offsets.sort((a, b) => a - b);
  return offsets.map(o => new Date(o).toISOString());
}