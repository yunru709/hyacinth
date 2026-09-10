// ============================================================
// UI 协议层 — 调度域测试（schedule.*）
// ============================================================
// 用 mock SchedulerLike（getTasks/getStatus）验证 schedule.list：
//  1. schedule.list → 返回任务列表 + 状态
//  2. 无调度器（getScheduler 返回 null）→ 返回空列表
//  3. 任务字段映射（name/scheduleType/enabled/nextRunAt/runCount）
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createScheduleDomain, type SchedulerLike, type SchedulerStatusLike } from './schedule.js';
import type { UiResponse, ScheduledTaskLike } from '../types.js';

/** 构造 mock 调度器 */
function makeScheduler(tasks: ScheduledTaskLike[], status?: SchedulerStatusLike): SchedulerLike {
  return {
    getTasks: () => tasks,
    getStatus: status ? () => status : undefined,
  };
}

/** 建立完整链路：mock SchedulerLike + InProc + 协议服务器 */
function setup(scheduler: SchedulerLike | null) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('schedule', createScheduleDomain({
    getScheduler: () => scheduler,
  }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });

  const waitForResponse = async (id: string, timeout = 2000): Promise<UiResponse> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout waiting for response "${id}"`);
  };

  return { client, waitForResponse };
}

describe('调度域', () => {
  it('schedule.list 返回任务列表 + 状态', async () => {
    const tasks: ScheduledTaskLike[] = [{
      id: 't1',
      name: 'morning-reminder',
      scheduleType: 'daily',
      enabled: true,
      lastRunAt: '2026-08-27T00:00:00.000Z',
      nextRunAt: '2026-08-28T00:00:00.000Z',
      runCount: 3,
      errorCount: 0,
      tags: ['reminder'],
      channel: 'feishu',
    }];
    const scheduler = makeScheduler(tasks, { running: true, taskCount: 1, enabledTaskCount: 1, startedAt: '2026-08-27T00:00:00.000Z' });
    const { client, waitForResponse } = setup(scheduler);

    client.send({ kind: 'request', id: 'l1', method: 'schedule.list' });
    const resp = await waitForResponse('l1');
    expect(resp.ok).toBe(true);
    const result = resp.result as { tasks: ScheduledTaskLike[]; status: SchedulerStatusLike };
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: 't1',
      name: 'morning-reminder',
      scheduleType: 'daily',
      enabled: true,
      runCount: 3,
      channel: 'feishu',
    });
    expect(result.status).toMatchObject({ running: true, taskCount: 1 });
  });

  it('schedule.list 无调度器时返回空列表（不报错）', async () => {
    const { client, waitForResponse } = setup(null);

    client.send({ kind: 'request', id: 'l1', method: 'schedule.list' });
    const resp = await waitForResponse('l1');
    expect(resp.ok).toBe(true);
    const result = resp.result as { tasks: ScheduledTaskLike[] };
    expect(result.tasks).toEqual([]);
  });

  it('schedule.list 任务字段映射：禁用任务 + 无状态时仍返回', async () => {
    const tasks: ScheduledTaskLike[] = [{
      id: 't2',
      name: 'weekly-report',
      scheduleType: 'cron',
      enabled: false,
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      errorCount: 1,
      tags: [],
    }];
    const scheduler = makeScheduler(tasks); // 无 getStatus
    const { client, waitForResponse } = setup(scheduler);

    client.send({ kind: 'request', id: 'l1', method: 'schedule.list' });
    const resp = await waitForResponse('l1');
    expect(resp.ok).toBe(true);
    const result = resp.result as { tasks: ScheduledTaskLike[]; status?: SchedulerStatusLike };
    expect(result.tasks[0]).toMatchObject({ enabled: false, errorCount: 1 });
    // 无 getStatus → status 为 undefined，不阻塞
    expect(result.status).toBeUndefined();
  });

  it('schedule.add 委托 addTask（含 schedule/action/tags）', async () => {
    const added: unknown[] = [];
    const scheduler: SchedulerLike = {
      getTasks: () => [],
      addTask: async (name, scheduleType, schedule, action, tags, channel, fallback) => {
        added.push({ name, scheduleType, schedule, action, tags, channel, fallback });
        return { id: 'n1', name };
      },
    };
    const { client, waitForResponse } = setup(scheduler);

    client.send({
      kind: 'request', id: 'a1', method: 'schedule.add',
      params: {
        name: 'daily-report', scheduleType: 'daily', schedule: { time: '09:00' },
        action: { type: 'command', target: '/report' }, tags: ['report'], channel: 'feishu',
      },
    });
    const resp = await waitForResponse('a1');
    expect(resp.ok).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: 'daily-report', scheduleType: 'daily', schedule: { time: '09:00' },
      action: { type: 'command', target: '/report' }, tags: ['report'], channel: 'feishu',
    });
  });

  it('schedule.add 缺参时报错', async () => {
    const { client, waitForResponse } = setup({ getTasks: () => [] });
    client.send({ kind: 'request', id: 'a2', method: 'schedule.add', params: { name: 'x' } });
    const resp = await waitForResponse('a2');
    expect(resp.ok).toBe(false);
  });

  it('schedule.remove 委托 deleteTask', async () => {
    const removed: string[] = [];
    const scheduler: SchedulerLike = {
      getTasks: () => [],
      deleteTask: async (id) => { removed.push(id); return true; },
    };
    const { client, waitForResponse } = setup(scheduler);
    client.send({ kind: 'request', id: 'r1', method: 'schedule.remove', params: { id: 't1' } });
    const resp = await waitForResponse('r1');
    expect(resp.ok).toBe(true);
    expect(removed).toEqual(['t1']);
  });

  it('schedule.toggle 委托 enableTask/disableTask', async () => {
    const ops: Array<{ id: string; enable: boolean }> = [];
    const scheduler: SchedulerLike = {
      getTasks: () => [],
      enableTask: async (id) => { ops.push({ id, enable: true }); return true; },
      disableTask: async (id) => { ops.push({ id, enable: false }); return true; },
    };
    const { client, waitForResponse } = setup(scheduler);

    client.send({ kind: 'request', id: 't1', method: 'schedule.toggle', params: { id: 'x1', enabled: true } });
    const r1 = await waitForResponse('t1');
    expect(r1.ok).toBe(true);

    client.send({ kind: 'request', id: 't2', method: 'schedule.toggle', params: { id: 'x2', enabled: false } });
    const r2 = await waitForResponse('t2');
    expect(r2.ok).toBe(true);

    expect(ops).toEqual([{ id: 'x1', enable: true }, { id: 'x2', enable: false }]);
  });
});

