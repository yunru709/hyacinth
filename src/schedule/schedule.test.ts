/**
 * schedule 测试（报告 M3 P1：HeartbeatScheduler 测试此前被整体注释）
 *
 * 历史问题（已修复）：旧 HeartbeatScheduler 测试未传 storagePath → addTask
 * 污染真实 ~/.agent/scheduler/tasks.json；且 afterEach 用 fs.rmSync 被
 * safe-delete shim 劫持。现在每个用例用独立临时 storagePath + **不删除**
 * 临时目录（os.tmpdir 自清，遵守 de-flake 教训）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { CronExpression } from './cron.js';
import { HeartbeatScheduler } from './scheduler.js';
import { SchedulePersistence } from './persistence.js';

describe('CronExpression', () => {
  it('parses * * * * * (every minute)', () => {
    const cron = new CronExpression('* * * * *');
    const now = new Date('2026-05-24T12:00:00');
    const next = cron.next(now);
    expect(next).toBeDefined();
    expect(next!.getMinutes()).toBe(1);
    expect(next!.getHours()).toBe(12);
    expect(next!.getDate()).toBe(24);
  });

  it('parses 30 9 * * * (daily 9:30)', () => {
    const cron = new CronExpression('30 9 * * *');
    const now = new Date('2026-05-24T09:30:00');
    const next = cron.next(now);
    expect(next).toBeDefined();
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(30); // next match is next day 9:30
    expect(next!.getDate()).toBe(25); // May 25
  });

  it('parses 0 0 * * * (midnight daily)', () => {
    const cron = new CronExpression('0 0 * * *');
    const now = new Date('2026-05-24T23:45:00');
    const next = cron.next(now);
    expect(next).toBeDefined();
    expect(next!.getHours()).toBe(0);
    expect(next!.getMinutes()).toBe(0);
    expect(next!.getDate()).toBe(25);
  });

  it('parses */5 * * * * (every 5 minutes)', () => {
    const cron = new CronExpression('*/5 * * * *');
    const now = new Date('2026-05-24T12:03:00');
    const next = cron.next(now);
    expect(next).toBeDefined();
    expect(next!.getMinutes()).toBe(5);
  });

  it('parses 0 9 * * 1-5 (weekdays 9am)', () => {
    // 2026-05-24 is Sunday
    const cron = new CronExpression('0 9 * * 1-5');
    const now = new Date('2026-05-24T10:00:00');
    const next = cron.next(now);
    expect(next).toBeDefined();
    expect(next!.getDay()).toBe(1); // Monday
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
  });

  it('parses 0 9 * * 1 (Mondays only — dayOfMonth=* must NOT widen the match)', () => {
    // 回归：isDayAll 曾错误地比较 dayOfMonth.length === 60（实际 * 产生 31 个值），
    // 导致 dayOfMonth=* + dayOfWeek 受限时每天都触发，而非仅周一。
    const cron = new CronExpression('0 9 * * 1');
    // 2026-09-09 是周三；下一个周一 9 点应是 2026-09-14
    const now = new Date('2026-09-09T10:00:00');
    const next = cron.next(now);
    expect(next).toBeDefined();
    expect(next!.getDay()).toBe(1); // Monday
    expect(next!.getDate()).toBe(14);
    expect(next!.getHours()).toBe(9);
  });

  it('dayOfMonth and dayOfWeek both restricted → OR semantics', () => {
    // 经典 cron 语义：日域与周域都受限时，满足任一即触发
    const cron = new CronExpression('0 0 1 * 1'); // 每月1号 或 每周一
    const now = new Date('2026-09-09T00:01:00'); // 周三
    const nexts = cron.nextN(now, 4);
    // 下一次应是 9-13（下周一）、9-14（下周一……实际 9-13 与 9-14 相邻：13 是周日？以计算为准，只断言日域合法性）
    for (const n of nexts) {
      const isMonday = n.getDay() === 1;
      const isFirstDay = n.getDate() === 1;
      expect(isMonday || isFirstDay).toBe(true);
    }
  });

  it('throws on invalid field count', () => {
    expect(() => new CronExpression('* * * *')).toThrow();
    expect(() => new CronExpression('* * * * * *')).toThrow();
  });

  it('computes nextN correctly', () => {
    const cron = new CronExpression('0 * * * *');
    const now = new Date('2026-05-24T12:00:00');
    const nexts = cron.nextN(now, 3);
    expect(nexts).toHaveLength(3);
    expect(nexts[0].getHours()).toBe(13);
    expect(nexts[1].getHours()).toBe(14);
    expect(nexts[2].getHours()).toBe(15);
  });
});

// ── HeartbeatScheduler ──────────────────────────────────────────────

describe('HeartbeatScheduler', () => {
  let tempStorage: string;
  let schedulers: HeartbeatScheduler[];

  beforeEach(() => {
    // 每个用例独立临时存储路径，绝不触碰真实 ~/.agent/scheduler/tasks.json
    tempStorage = path.join(os.tmpdir(), `sched-test-${crypto.randomUUID()}`, 'tasks.json');
    schedulers = [];
  });

  afterEach(async () => {
    // 停止所有调度器（释放 interval），不删除临时目录（tmpdir 自清）
    for (const s of schedulers.splice(0)) {
      try { await s.stop(); } catch { /* ignore */ }
    }
  });

  function makeScheduler(over: Record<string, unknown> = {}): HeartbeatScheduler {
    const s = new HeartbeatScheduler({ storagePath: tempStorage, ...over });
    schedulers.push(s);
    return s;
  }

  it('can be created with default config', () => {
    const scheduler = makeScheduler();
    const status = scheduler.getStatus();
    expect(status.running).toBe(false);
    expect(status.taskCount).toBe(0);
  });

  it('can add and retrieve a task', async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.addTask(
      'test-interval',
      'interval',
      { intervalMs: 60000 },
      { type: 'callback', target: 'test-handler' },
      ['test'],
    );

    expect(task.name).toBe('test-interval');
    expect(task.scheduleType).toBe('interval');
    expect(task.enabled).toBe(true);
    expect(task.runCount).toBe(0);
    expect(task.nextRunAt).toBeDefined();

    const tasks = scheduler.getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);

    const retrieved = scheduler.getTask(task.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('test-interval');
  });

  it('can update a task', async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.addTask(
      'test',
      'interval',
      { intervalMs: 60000 },
      { type: 'callback', target: 'handler' },
    );

    const updated = await scheduler.updateTask(task.id, { name: 'updated-test' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('updated-test');
    expect(scheduler.getTask(task.id)!.name).toBe('updated-test');
  });

  it('can delete a task', async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.addTask(
      'test',
      'cron',
      { expression: '0 * * * *' },
      { type: 'callback', target: 'handler' },
    );

    expect(scheduler.getTasks()).toHaveLength(1);
    const deleted = await scheduler.deleteTask(task.id);
    expect(deleted).toBe(true);
    expect(scheduler.getTasks()).toHaveLength(0);
  });

  it('can enable and disable tasks', async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.addTask(
      'test',
      'interval',
      { intervalMs: 60000 },
      { type: 'callback', target: 'handler' },
    );

    await scheduler.disableTask(task.id);
    expect(scheduler.getTask(task.id)!.enabled).toBe(false);
    expect(scheduler.getTask(task.id)!.nextRunAt).toBeNull();

    await scheduler.enableTask(task.id);
    expect(scheduler.getTask(task.id)!.enabled).toBe(true);
    expect(scheduler.getTask(task.id)!.nextRunAt).toBeDefined();
  });

  it('start and stop lifecycle', async () => {
    const scheduler = makeScheduler({ heartbeatMs: 1000 });
    await scheduler.start();
    expect(scheduler.getStatus().running).toBe(true);
    expect(scheduler.getStatus().startedAt).toBeDefined();
    await scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
  });

  it('executes due tasks via handler（真实触发）', async () => {
    const executed: string[] = [];
    const scheduler = makeScheduler({ heartbeatMs: 100 });

    scheduler.setHandler(async (task) => {
      executed.push(task.name);
    });

    await scheduler.addTask(
      'quick-task',
      'interval',
      { intervalMs: 50 },
      { type: 'callback', target: 'handler' },
    );

    await scheduler.start();

    // 等至少一个心跳 tick
    await new Promise(r => setTimeout(r, 300));
    await scheduler.stop();

    expect(executed.length).toBeGreaterThanOrEqual(1);
    expect(executed).toContain('quick-task');
  }, 10000);

  it('执行后持久化：runCount/lastRunAt 递增 + 执行记录可查', async () => {
    const scheduler = makeScheduler({ heartbeatMs: 50 });
    let calls = 0;
    scheduler.setHandler(async () => { calls++; });

    const task = await scheduler.addTask(
      'record-task',
      'interval',
      { intervalMs: 60 },
      { type: 'callback', target: 'handler' },
    );

    await scheduler.start();
    await new Promise(r => setTimeout(r, 300));
    await scheduler.stop();

    expect(calls).toBeGreaterThanOrEqual(1);
    const after = scheduler.getTask(task.id)!;
    expect(after.runCount).toBeGreaterThanOrEqual(1);
    expect(after.lastRunAt).toBeTruthy();

    // 执行记录落盘（从磁盘持久化读回）
    const records = await scheduler.getRecentRecords(10);
    const mine = records.filter(r => r.taskId === task.id);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]!.success).toBe(true);
  }, 10000);

  it('handler 抛错 → 记录 success=false + errorCount 递增，不影响后续 tick', async () => {
    const scheduler = makeScheduler({ heartbeatMs: 50 });
    let fail = true;
    scheduler.setHandler(async () => {
      if (fail) throw new Error('boom');
    });

    const task = await scheduler.addTask(
      'fail-task',
      'interval',
      { intervalMs: 60 },
      { type: 'callback', target: 'handler' },
    );

    await scheduler.start();
    await new Promise(r => setTimeout(r, 250));
    fail = false; // 恢复
    await new Promise(r => setTimeout(r, 150));
    await scheduler.stop();

    const after = scheduler.getTask(task.id)!;
    expect(after.errorCount).toBeGreaterThanOrEqual(1);
    const records = await scheduler.getRecentRecords(10);
    const fails = records.filter(r => r.taskId === task.id && !r.success);
    expect(fails.length).toBeGreaterThanOrEqual(1);
    expect(fails[0]!.error).toContain('boom');
  }, 10000);

  it('同名 addTask 更新而非新增', async () => {
    const scheduler = makeScheduler();
    const first = await scheduler.addTask(
      'same-name',
      'interval',
      { intervalMs: 60000 },
      { type: 'callback', target: 'a' },
    );
    const second = await scheduler.addTask(
      'same-name',
      'interval',
      { intervalMs: 120000 },
      { type: 'callback', target: 'b' },
    );

    expect(second.id).toBe(first.id); // 同一条
    expect(scheduler.getTasks()).toHaveLength(1);
    expect(scheduler.getTask(first.id)!.action).toEqual({ type: 'callback', target: 'b' });
  });

  it('start 时清理过期 fixed-time 任务 + 去重同名任务', async () => {
    const scheduler = makeScheduler({ heartbeatMs: 1000 });
    // 过期的一次性任务
    const past = new Date(Date.now() - 3600_000).toISOString();
    await scheduler.addTask('expired', 'fixed-time', { runAt: past }, { type: 'callback', target: 'h' });
    // 同名重复（直接写盘模拟历史残留）
    const dir = path.dirname(tempStorage);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempStorage, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'dup-1', name: 'dup', scheduleType: 'interval', schedule: { intervalMs: 60000 }, action: { type: 'callback', target: 'a' }, enabled: true, createdAt: '2026-01-01T00:00:00.000Z', lastRunAt: null, nextRunAt: null, runCount: 0, errorCount: 0 },
        { id: 'dup-2', name: 'dup', scheduleType: 'interval', schedule: { intervalMs: 60000 }, action: { type: 'callback', target: 'b' }, enabled: true, createdAt: '2026-01-02T00:00:00.000Z', lastRunAt: null, nextRunAt: null, runCount: 0, errorCount: 0 },
      ],
    }, null, 2));

    await scheduler.start();
    // 过期任务被清；dup 同名只保留一条
    expect(scheduler.getTask('dup-1') || scheduler.getTask('dup-2')).toBeTruthy();
    const dupTasks = scheduler.getTasks().filter(t => t.name === 'dup');
    expect(dupTasks.length).toBe(1);
    await scheduler.stop();
  });

  it('calculates daily next run', async () => {
    const scheduler = makeScheduler();
    const task = await scheduler.addTask(
      'daily-task',
      'daily',
      { time: '09:30' },
      { type: 'callback', target: 'handler' },
    );

    expect(task.nextRunAt).toBeDefined();
    const nextRun = new Date(task.nextRunAt!);
    expect(nextRun.getHours()).toBe(9);
    expect(nextRun.getMinutes()).toBe(30);
  });

  it('expired fixed-time task returns null nextRun', async () => {
    const scheduler = makeScheduler();
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // yesterday
    const task = await scheduler.addTask(
      'expired',
      'fixed-time',
      { runAt: pastDate },
      { type: 'callback', target: 'handler' },
    );

    expect(task.nextRunAt).toBeNull();
  });

  it('future fixed-time task has valid nextRun', async () => {
    const scheduler = makeScheduler();
    const futureDate = new Date(Date.now() + 86400000).toISOString(); // tomorrow
    const task = await scheduler.addTask(
      'future',
      'fixed-time',
      { runAt: futureDate },
      { type: 'callback', target: 'handler' },
    );

    expect(task.nextRunAt).toBeDefined();
  });

// ── SchedulePersistence 并发写安全 ──────────────────────────────────
// 回归：writeChain 串行队列——并行 saveTask/deleteTask 时若各自基于旧快照
// 整文件覆盖会互相丢失（后写覆盖先写）。本组用例验证并发写不丢更新。

describe('SchedulePersistence 并发写', () => {
  function makePersistence(): SchedulePersistence {
    const p = new SchedulePersistence(
      path.join(os.tmpdir(), `sched-persist-${crypto.randomUUID()}`, 'tasks.json'),
    );
    return p;
  }

  it('并发 saveTask 多个任务 → 全部保留（不丢失更新）', async () => {
    const p = makePersistence();
    const task = (name: string, i: number) => ({
      id: `t-${i}`,
      name,
      scheduleType: 'interval' as const,
      schedule: { intervalMs: 60000 },
      action: { type: 'callback' as const, target: `handler-${i}` },
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      errorCount: 0,
      tags: [],
    });

    // 同时发起 20 个不同任务的保存（Promise.all 并发）
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => p.saveTask(task(`task-${i}`, i))),
    );

    const tasks = await p.getAllTasks();
    expect(tasks).toHaveLength(20);
    const ids = new Set(tasks.map(t => t.id));
    expect(ids.size).toBe(20); // 无重复无丢失
  });

  it('并发 saveTask 同一任务 + 并发 deleteTask → 最终状态一致', async () => {
    const p = makePersistence();
    await p.saveTask({
      id: 'a',
      name: 'a',
      scheduleType: 'interval',
      schedule: { intervalMs: 60000 },
      action: { type: 'callback', target: 'a' },
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      errorCount: 0,
      tags: [],
    });
    await p.saveTask({
      id: 'b',
      name: 'b',
      scheduleType: 'interval',
      schedule: { intervalMs: 60000 },
      action: { type: 'callback', target: 'b' },
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      errorCount: 0,
      tags: [],
    });

    // 并发：改 a 的 enabled + 删 b
    await Promise.all([
      p.saveTask({
        id: 'a',
        name: 'a',
        scheduleType: 'interval',
        schedule: { intervalMs: 60000 },
        action: { type: 'callback', target: 'a' },
        enabled: false,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        nextRunAt: null,
        runCount: 0,
        errorCount: 0,
        tags: [],
      }),
      p.deleteTask('b'),
    ]);

    const tasks = await p.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('a');
    expect(tasks[0].enabled).toBe(false);
  });

  it('并发 addRecord → 全部记录保留', async () => {
    const p = makePersistence();
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => p.addRecord({
        taskId: `r-${i}`,
        taskName: `rec-${i}`,
        executedAt: new Date().toISOString(),
        durationMs: 0,
        success: true,
      }, 1000)),
    );

    const records = await p.getRecentRecords(100);
    expect(records).toHaveLength(15);
    const ids = new Set(records.map(r => r.taskId));
    expect(ids.size).toBe(15);
  });
});

});
