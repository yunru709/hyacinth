/**
 * time-source 热更回归（2026-10-31 修复）
 *
 * 锁死：「同 id 规则改了 schedule 就要重算」，不被旧缓存卡死。
 * 旧实现 `nextRun: Map<id, number|null>` 见 id 存在就返回旧值：
 *   · fixed-time 触发过一次后缓存写成 null ⇒ 改 runAt 永不触发，只能重启；
 *   · daily/interval 改配置后仍按旧配置算一次。
 * 修复：缓存存 schedule 内容签名，签名变即重算。
 */
import { describe, it, expect } from 'vitest';
import { createTimeSource } from './time-source.js';
import type { AutomationRule } from './types.js';

function mkRule(id: string, schedule: Record<string, unknown>): AutomationRule {
  return { id, name: id, enabled: true, when: { kind: 'time', schedule }, do: [] };
}

describe('time-source 热更（2026-10-31 回归）', () => {
  it('fixed-time 触发后改 runAt → 能再次触发（旧实现因缓存 null 卡死）', async () => {
    let clock = Date.parse('2026-10-31T10:00:00Z');
    const rules: AutomationRule[] = [mkRule('t', { runAt: new Date(clock + 1000).toISOString() })];
    const fired: string[] = [];
    const ts = createTimeSource({
      getRules: () => rules,
      fire: (id) => { fired.push(id); },
      tickMs: 5,
      now: () => clock,
    });
    ts.start();

    clock += 1500; // 第一次到点
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toEqual(['t']);

    // 热更：改成新的未来时刻（同 id，schedule 内容变了 ⇒ 签名变 ⇒ 必须重算）
    clock += 60000;
    rules[0].when = { kind: 'time', schedule: { runAt: new Date(clock + 1000).toISOString() } };
    clock += 1500;
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toEqual(['t', 't']);

    ts.stop();
  });

  it('schedule 未变 → 沿用缓存，不重复触发', async () => {
    let clock = Date.parse('2026-10-31T10:00:00Z');
    const rules: AutomationRule[] = [mkRule('t', { intervalMs: 5000 })];
    let fired = 0;
    const ts = createTimeSource({
      getRules: () => rules,
      fire: () => { fired += 1; },
      tickMs: 5,
      now: () => clock,
    });
    ts.start();

    clock += 6000;
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(1);
    ts.stop();
  });
});
