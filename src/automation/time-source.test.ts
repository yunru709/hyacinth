/**
 * 时间源测试（2026-10-30）
 *
 * 重点：**到点触发一次、fixed-time 只触发一次、disabled 不触发**。
 * 用注入的 now() 控制时间，避免真实等待。
 */

import { describe, expect, it, vi } from 'vitest';

import { computeNextRun, createTimeSource } from './time-source.js';
import type { AutomationRule } from './types.js';

function rule(id: string, schedule: Record<string, unknown>, enabled = true): AutomationRule {
  return {
    id,
    name: `rule-${id}`,
    enabled,
    when: { kind: 'time', schedule },
    do: [{ sink: 'invoke', tool: 'say', args: { content: 'x' } }],
  };
}

describe('computeNextRun', () => {
  const T = new Date('2026-10-30T10:00:00+08:00').getTime();

  it('interval → from + intervalMs', () => {
    expect(computeNextRun({ intervalMs: 60_000 }, T)).toBe(T + 60_000);
  });

  it('daily → 今天该时刻（未过）', () => {
    const next = computeNextRun({ time: '18:30' }, T);
    const d = new Date(next as number);
    expect(d.getHours()).toBe(18);
    expect(d.getMinutes()).toBe(30);
    expect(next).toBeGreaterThan(T);
  });

  it('daily → 今天已过则顺延到明天', () => {
    const next = computeNextRun({ time: '08:00' }, T) as number;
    expect(next - T).toBeGreaterThan(12 * 3600_000); // 至少隔半天
  });

  it('fixed-time → 未来时刻返回该时刻，已过返回 null', () => {
    expect(computeNextRun({ runAt: '2030-01-01T00:00:00Z' }, T)).toBeGreaterThan(T);
    expect(computeNextRun({ runAt: '2020-01-01T00:00:00Z' }, T)).toBeNull();
  });

  it('不支持的配置 → null', () => {
    expect(computeNextRun({ cron: '0 3 * * *' }, T)).toBeNull();
    expect(computeNextRun({}, T)).toBeNull();
  });
});

describe('createTimeSource', () => {
  it('到点触发 fire(ruleId)，并推进下一次', async () => {
    let now = 1_000_000;
    const fired: string[] = [];
    const src = createTimeSource({
      getRules: () => [rule('r1', { intervalMs: 1000 })],
      fire: (id) => {
        fired.push(id);
      },
      tickMs: 10,
      now: () => now,
    });
    src.start();

    // 首次 tick 只登记 nextRun（= now + 1000），不触发
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toEqual([]);

    // 推进时间到点
    now += 1000;
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toEqual(['r1']);

    src.stop();
  });

  it('disabled 的规则不触发', async () => {
    let now = 0;
    const fired: string[] = [];
    const src = createTimeSource({
      getRules: () => [rule('r1', { intervalMs: 100 }, false)],
      fire: (id) => {
        fired.push(id);
      },
      tickMs: 10,
      now: () => now,
    });
    src.start();
    now += 1000;
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toEqual([]);
    src.stop();
  });

  it('fixed-time 只触发一次', async () => {
    const at = 2_000_000;
    let now = at - 500;
    const fired: string[] = [];
    const src = createTimeSource({
      getRules: () => [rule('r1', { runAt: new Date(at).toISOString() })],
      fire: (id) => {
        fired.push(id);
      },
      tickMs: 10,
      now: () => now,
    });
    src.start();

    now = at + 10;
    await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toEqual(['r1']); // 只一次

    src.stop();
  });

  it('fire 抛错不影响后续规则', async () => {
    let now = 0;
    const fired: string[] = [];
    const src = createTimeSource({
      getRules: () => [rule('bad', { intervalMs: 100 }), rule('good', { intervalMs: 100 })],
      fire: (id) => {
        if (id === 'bad') throw new Error('boom');
        fired.push(id);
      },
      tickMs: 10,
      now: () => now,
    });
    src.start();
    now += 100;
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toEqual(['good']); // bad 抛错但 good 照跑
    src.stop();
  });

  it('snapshot 反映 nextRunAt', async () => {
    const now = 1000;
    const src = createTimeSource({
      getRules: () => [rule('r1', { intervalMs: 500 })],
      fire: () => {},
      tickMs: 10,
      now: () => now,
    });
    src.start();
    await new Promise((r) => setTimeout(r, 30));
    const snap = src.snapshot();
    expect(snap).toEqual([{ ruleId: 'r1', nextRunAt: 1500 }]);
    src.stop();
  });
});
