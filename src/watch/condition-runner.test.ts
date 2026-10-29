/**
 * ConditionTaskRunner 单测（2026-10-29 自动化改造）
 *
 * 重点盯三件事（都是"错了很难查"的）：
 *   1. arm 幂等 —— 重复 arm 若不去重，会挂出多个 watcher，同一条件反复唤醒
 *   2. disarm 真的停掉 —— 否则任务删了、监控还在跑
 *   3. taskId ↔ watchId 映射正确 —— schedule 只知道 taskId，停错就停不掉
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ConditionTaskSpec } from '../schedule/condition-port.js';
import { createConditionTaskRunner } from './condition-runner.js';
import { getWatchService } from './service-instance.js';

function makeTask(id: string, over: Partial<ConditionTaskSpec> = {}): ConditionTaskSpec {
  return {
    id,
    name: `task-${id}`,
    enabled: true,
    trigger: {
      type: 'condition',
      kind: 'file',
      spec: { path: 'C:\\__never_exists_watch_test__\\x.txt' },
      intervalMs: 60_000, // 给大间隔：测试期间不会真的采样多次
    },
    ...over,
  };
}

afterEach(() => {
  // 清理全局单例上残留的 watcher，避免污染其它测试文件
  const svc = getWatchService();
  for (const w of svc.list()) svc.stop(w.watchId);
});

describe('ConditionTaskRunner', () => {
  it('arm 后登记，taskId 出现在 listArmed', () => {
    const runner = createConditionTaskRunner();
    runner.arm(makeTask('t1'));
    expect(runner.listArmed()).toContain('t1');
    // 全局 WatchService 里确实多了一个监控
    expect(getWatchService().list().length).toBe(1);
  });

  it('重复 arm 幂等：不会挂出第二个 watcher', () => {
    const runner = createConditionTaskRunner();
    runner.arm(makeTask('t1'));
    runner.arm(makeTask('t1'));
    runner.arm(makeTask('t1'));

    expect(runner.listArmed()).toEqual(['t1']);
    // 关键断言：WatchService 里只应有 1 个，而不是 3 个（重复会导致唤醒风暴）
    expect(getWatchService().list().length).toBe(1);
  });

  it('disarm 真正停掉 watcher', () => {
    const runner = createConditionTaskRunner();
    runner.arm(makeTask('t1'));
    runner.disarm('t1');

    expect(runner.listArmed()).toEqual([]);
    expect(getWatchService().list().length).toBe(0);
  });

  it('disarm 不存在的 taskId 静默成功', () => {
    const runner = createConditionTaskRunner();
    expect(() => runner.disarm('nope')).not.toThrow();
  });

  it('disarmAll 清空全部', () => {
    const runner = createConditionTaskRunner();
    runner.arm(makeTask('t1'));
    runner.arm(makeTask('t2'));
    expect(getWatchService().list().length).toBe(2);

    runner.disarmAll();
    expect(runner.listArmed()).toEqual([]);
    expect(getWatchService().list().length).toBe(0);
  });

  it('带 channel+sessionId 时监控带 owner（事件才能唤醒对应会话）', () => {
    const runner = createConditionTaskRunner();
    runner.arm(makeTask('t1', { channel: 'webui', sessionId: 's1' }));

    const watch = getWatchService().list()[0];
    expect(watch.owner).toEqual({ channel: 'webui', sessionId: 's1' });
  });

  it('缺 channel/sessionId 时不带 owner（只记事件不唤醒）', () => {
    const runner = createConditionTaskRunner();
    runner.arm(makeTask('t1'));
    expect(getWatchService().list()[0].owner).toBeUndefined();
  });
});
