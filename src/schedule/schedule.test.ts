import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { CronExpression } from './cron.js';
import { HeartbeatScheduler } from './scheduler.js';

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

/* 暂时注释（2026-08-05）：HeartbeatScheduler 测试会 addTask 注册测试性定时任务，
   曾污染真实 ~/.agent/scheduler/tasks.json（残留 expired/updated-test）。恢复时删掉本注释块。
describe('HeartbeatScheduler', () => {
  // 每个测试用独立临时存储路径，避免共享 ~/.agent/scheduler/tasks.json（互相污染 + 污染真实数据）
  let tempStorage: string;
  beforeEach(() => {
    tempStorage = path.join(os.tmpdir(), `sched-test-${crypto.randomUUID()}`, 'tasks.json');
  });
  afterEach(() => {
    try { fs.rmSync(path.dirname(tempStorage), { recursive: true, force: true }); } catch { // ignore
  });

  it('can be created with default config', () => {
    const scheduler = new HeartbeatScheduler({ storagePath: tempStorage });
    const status = scheduler.getStatus();
    expect(status.running).toBe(false);
    expect(status.taskCount).toBe(0);
  });

  it('can add and retrieve a task', async () => {
    const scheduler = new HeartbeatScheduler({ storagePath: tempStorage });
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
    const scheduler = new HeartbeatScheduler({ storagePath: tempStorage });
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
    const scheduler = new HeartbeatScheduler({ storagePath: tempStorage });
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
    const scheduler = new HeartbeatScheduler({ storagePath: tempStorage });
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
    const scheduler = new HeartbeatScheduler({ heartbeatMs: 1000, storagePath: tempStorage });
    await scheduler.start();
    expect(scheduler.getStatus().running).toBe(true);
    expect(scheduler.getStatus().startedAt).toBeDefined();
    await scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
  });

  it('executes due tasks via handler', async () => {
    const executed: string[] = [];
    const scheduler = new HeartbeatScheduler({ heartbeatMs: 100, storagePath: tempStorage });

    scheduler.setHandler(async (task) => {
      executed.push(task.name);
    });

    // Add a short-interval task
    await scheduler.addTask(
      'quick-task',
      'interval',
      { intervalMs: 50 },
      { type: 'callback', target: 'handler' },
    );

    await scheduler.start();

    // Wait for at least one tick
    await new Promise(r => setTimeout(r, 300));

    await scheduler.stop();

    expect(executed.length).toBeGreaterThanOrEqual(1);
    expect(executed).toContain('quick-task');
  }, 10000);

  it('calculates daily next run', async () => {
    const scheduler = new HeartbeatScheduler({ storagePath: tempStorage });
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
    const scheduler = new HeartbeatScheduler({ storagePath: tempStorage });
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
    const scheduler = new HeartbeatScheduler({ storagePath: tempStorage });
    const futureDate = new Date(Date.now() + 86400000).toISOString(); // tomorrow
    const task = await scheduler.addTask(
      'future',
      'fixed-time',
      { runAt: futureDate },
      { type: 'callback', target: 'handler' },
    );

    expect(task.nextRunAt).toBeDefined();
  });
});
*/
