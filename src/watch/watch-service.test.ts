/**
 * WatchService（后台挂起模式）单测 — 2026-10-29
 *
 * 用假定时器手动推进，不依赖真实时钟；Probe 用脚本化假实现。
 * 重点验证三件容易写错的事：
 *   1. 事件带 owner（否则多会话串线）
 *   2. 命中后进入冷却期，冷却内不重复抛事件（防唤醒风暴）
 *   3. once=true 触发后自动停止
 */

import { describe, expect, it } from 'vitest';

import { ProbeRegistry } from './probes/registry.js';
import type { Probe, ProbeInstance, ProbeSample, WatchSpec } from './types.js';
import { WatchService, type WatchEvent } from './watch-service.js';

/** 脚本化 probe：每次 sample 返回预设指纹序列中的下一个 */
function makeScriptedProbe(values: string[]): Probe {
  return {
    kind: 'file',
    description: 'scripted probe for tests',
    create(): ProbeInstance {
      let i = 0;
      return {
        async sample(): Promise<ProbeSample> {
          const v = values[Math.min(i, values.length - 1)];
          i += 1;
          return { ok: true, value: v };
        },
      };
    },
  };
}

/** 假定时器：手动 run() 触发回调 */
function makeFakeTimers() {
  const callbacks: Array<() => void> = [];
  return {
    setIntervalFn: (fn: () => void) => {
      callbacks.push(fn);
      return {};
    },
    clearIntervalFn: () => {},
    /** 手动推进 n 次 tick（含微任务冲刷） */
    async run(times = 1) {
      for (let k = 0; k < times; k += 1) {
        for (const cb of callbacks) cb();
        // 每个 tick 内部有 await，多刷几轮确保 promise 链走完
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

function setup(values: string[], opts: { now?: () => number } = {}) {
  const registry = new ProbeRegistry();
  registry.register(makeScriptedProbe(values));

  const events: WatchEvent[] = [];
  const timers = makeFakeTimers();
  let clock = 1_000;
  const service = new WatchService({
    registry,
    onEvent: (e) => {
      events.push(e);
    },
    clock: opts.now ?? (() => clock),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });

  return {
    service,
    events,
    timers,
    advance(ms: number) {
      clock += ms;
    },
    get now() {
      return clock;
    },
  };
}

const spec: WatchSpec = { kind: 'file', path: 'x' };

describe('WatchService（后台挂起）', () => {
  it('指纹变化时抛事件，且事件带上 owner', async () => {
    const h = setup(['a', 'a', 'b']);
    h.service.start(spec, { owner: { channel: 'webui', sessionId: 's1' } });

    await h.timers.run(3);

    expect(h.events.length).toBe(1);
    expect(h.events[0].watchId).toMatch(/^w1-file$/);
    expect(h.events[0].owner).toEqual({ channel: 'webui', sessionId: 's1' });
    expect(h.events[0].kind).toBe('file');
    expect(h.events[0].distance).toBeGreaterThan(0);
  });

  it('冷却期内不再抛事件（防唤醒风暴）', async () => {
    const h = setup(['a', 'b', 'c', 'd', 'e']);
    h.service.start(spec, { cooldownMs: 30_000 });

    await h.timers.run(1); // 首帧作基准
    await h.timers.run(1); // 第二帧变化 → 命中，进入冷却
    expect(h.events.length).toBe(1);

    // 冷却期内继续 tick：不应再抛
    await h.timers.run(3);
    expect(h.events.length).toBe(1);

    // 推进时钟越过冷却，再 tick 应恢复监控
    h.advance(31_000);
    await h.timers.run(2); // 冷却解除后重建基准 + 下一次命中
    expect(h.events.length).toBe(2);
  });

  it('once=true 触发后自动停止', async () => {
    const h = setup(['a', 'b', 'c']);
    const info = h.service.start(spec, { once: true });
    await h.timers.run(2);
    expect(h.events.length).toBe(1);
    expect(h.service.list().find((w) => w.watchId === info.watchId)).toBeUndefined();
  });

  it('采样失败不抛事件', async () => {
    const registry = new ProbeRegistry();
    registry.register({
      kind: 'file',
      description: 'always failing',
      create: () => ({
        async sample(): Promise<ProbeSample> {
          return { ok: false, value: '', error: 'boom' };
        },
      }),
    });
    const timers = makeFakeTimers();
    const events: WatchEvent[] = [];
    const service = new WatchService({
      registry,
      onEvent: (e) => {
        events.push(e);
      },
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    service.start(spec);
    await timers.run(3);
    expect(events.length).toBe(0);
    expect(service.list()[0].lastError).toMatch(/boom/);
  });

  it('stop 之后不再采样', async () => {
    const h = setup(['a', 'b']);
    const info = h.service.start(spec);
    expect(h.service.stop(info.watchId)).toBe(true);
    await h.timers.run(3);
    expect(h.events.length).toBe(0);
    expect(h.service.list().length).toBe(0);
    expect(h.service.stop(info.watchId)).toBe(false); // 重复停止返回 false
  });
});
