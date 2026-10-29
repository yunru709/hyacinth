/**
 * TriggerHub 单测（2026-10-29）
 *
 * 总线本身很薄，但有两件事必须钉住：
 *   1. sink 抛异常不能影响其它 sink（否则一次通知失败会拖垮定时器/监控）
 *   2. 扇出是串行有序的（并发会让"先唤醒再记日志"乱序）
 */

import { describe, expect, it, vi } from 'vitest';

import { TriggerHub, getGlobalTriggerHub, setGlobalTriggerHub } from './hub.js';
import type { TriggerEvent } from './types.js';

describe('TriggerHub', () => {
  it('把事件扇出给所有 sink', async () => {
    const hub = new TriggerHub();
    const a: TriggerEvent[] = [];
    const b: TriggerEvent[] = [];
    hub.registerSink((e) => {
      a.push(e);
    });
    hub.registerSink((e) => {
      b.push(e);
    });

    await hub.fire({ source: 'schedule', name: 'task-1' });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].source).toBe('schedule');
    expect(a[0].name).toBe('task-1');
    expect(typeof a[0].at).toBe('number');
  });

  it('某个 sink 抛异常不影响其它 sink', async () => {
    const errors: unknown[] = [];
    const hub = new TriggerHub({ onSinkError: (err) => errors.push(err) });
    const received: string[] = [];

    hub.registerSink(() => {
      throw new Error('sink A exploded');
    });
    hub.registerSink((e) => {
      received.push(e.name);
    });

    await expect(hub.fire({ source: 'watch', name: 'w1' })).resolves.toBeUndefined();
    expect(received).toEqual(['w1']);
    expect(errors).toHaveLength(1);
  });

  it('扇出顺序稳定（串行 await）', async () => {
    const hub = new TriggerHub();
    const order: string[] = [];

    hub.registerSink(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('slow-first');
    });
    hub.registerSink(() => {
      order.push('fast-second');
    });

    await hub.fire({ source: 'test', name: 'ordering' });

    // 若是并发扇出，fast-second 会先完成
    expect(order).toEqual(['slow-first', 'fast-second']);
  });

  it('取消注册后不再收到事件', async () => {
    const hub = new TriggerHub();
    const seen: string[] = [];
    const off = hub.registerSink((e) => {
      seen.push(e.name);
    });

    await hub.fire({ source: 's', name: 'one' });
    off();
    await hub.fire({ source: 's', name: 'two' });

    expect(seen).toEqual(['one']);
    expect(hub.sinkCount()).toBe(0);
  });

  it('历史与统计正确', async () => {
    let t = 1000;
    const hub = new TriggerHub({ historyLimit: 3, clock: () => t++ });

    await hub.fire({ source: 'schedule', name: 'a' });
    await hub.fire({ source: 'watch', name: 'b' });
    await hub.fire({ source: 'watch', name: 'c' });
    await hub.fire({ source: 'watch', name: 'd' }); // 超出上限，最早一条被挤出

    const recent = hub.recent(10);
    expect(recent.map((e) => e.name)).toEqual(['b', 'c', 'd']);

    const stats = hub.statsSnapshot();
    expect(stats.total).toBe(4);
    expect(stats.bySource).toEqual({ schedule: 1, watch: 3 });
    expect(stats.lastAt).not.toBeNull();
  });

  it('recent 的 limit 被夹在合理区间', async () => {
    const hub = new TriggerHub({ historyLimit: 5 });
    for (let i = 0; i < 5; i += 1) await hub.fire({ source: 's', name: `n${i}` });
    expect(hub.recent(0)).toHaveLength(1); // 至少 1
    expect(hub.recent(999)).toHaveLength(5); // 不超过实际条数
  });

  it('reset 清空状态', async () => {
    const hub = new TriggerHub();
    hub.registerSink(() => {});
    await hub.fire({ source: 's', name: 'x' });
    hub.reset();
    expect(hub.sinkCount()).toBe(0);
    expect(hub.recent(10)).toHaveLength(0);
    expect(hub.statsSnapshot().total).toBe(0);
  });
});

describe('全局单例', () => {
  it('未注册时返回 null（不自动创建）', () => {
    setGlobalTriggerHub(null);
    expect(getGlobalTriggerHub()).toBeNull();
  });

  it('注册后可取回同一个实例', () => {
    const hub = new TriggerHub();
    setGlobalTriggerHub(hub);
    expect(getGlobalTriggerHub()).toBe(hub);
    setGlobalTriggerHub(null); // 清理，避免影响其它测试文件
  });
});
