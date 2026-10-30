/**
 * automation/sources 测试 —— probe 规则的 arm / disarm（2026-10-30）
 *
 * 锁死的语义：
 *   1. 只 arm「enabled 且 when.kind==='probe'」的规则（time/event 不 arm）
 *   2. spec 合并：`{ kind, ...probe.spec }` —— 这是交给 WatchService 的最终形态
 *   3. options 透传：note / intervalMs / cooldownMs / threshold / settleFrames / once=false
 *   4. 单条 arm 失败 → 记入 errors，**不阻断**其它规则（否则一条写错全废）
 *   5. disarmWatchIds 逐个 stop；单个 stop 抛错不阻断其余
 */
import { describe, expect, it, vi } from 'vitest';

import { armProbeRules, disarmWatchIds } from './sources.js';
import type { AutomationRule } from './types.js';

/** 手写假 WatchArmer：记录 start/stop 的入参，可指定某 kind 抛错 */
function fakeWatch(opts: { failKinds?: string[]; failStopIds?: string[] } = {}) {
  const starts: Array<{ spec: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const stops: string[] = [];
  let n = 0;
  return {
    starts,
    stops,
    start(spec: Record<string, unknown>, options?: Record<string, unknown>) {
      if (opts.failKinds?.includes(String(spec.kind))) throw new Error(`bad spec for ${spec.kind}`);
      starts.push({ spec, options });
      return { watchId: `w${++n}` };
    },
    stop(id: string) {
      if (opts.failStopIds?.includes(id)) throw new Error(`cannot stop ${id}`);
      stops.push(id);
    },
  };
}

function probeRule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r1',
    name: '监控A',
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'file', spec: { path: 'C:/a.log' } } },
    do: [],
    ...over,
  };
}

describe('armProbeRules', () => {
  it('只 arm enabled 且 kind=probe 的规则；time/event/disabled 全部跳过', () => {
    const watch = fakeWatch();
    const rules: AutomationRule[] = [
      probeRule({ id: 'p1' }),
      { ...probeRule({ id: 't1', when: { kind: 'time', schedule: { intervalMs: 1000 } } }) },
      { ...probeRule({ id: 'e1', when: { kind: 'event', event: 'afterToolExecute' } }) },
      probeRule({ id: 'd1', enabled: false }),
    ];
    const res = armProbeRules(rules, watch);
    expect([...res.armed.keys()]).toEqual(['p1']);
    expect(watch.starts).toHaveLength(1);
    expect(res.errors).toEqual([]);
  });

  it('spec 合并为 `{ kind, ...probe.spec }`（交给 WatchService 的最终形态）', () => {
    const watch = fakeWatch();
    armProbeRules([probeRule({ when: { kind: 'probe', probe: { kind: 'process', spec: { name: 'notepad', expect: 'exit' } } } })], watch);
    expect(watch.starts[0].spec).toEqual({ kind: 'process', name: 'notepad', expect: 'exit' });
  });

  it('options 透传：note 带规则名 + 采样参数 + once=false（规则长期存在）', () => {
    const watch = fakeWatch();
    armProbeRules(
      [
        probeRule({
          when: {
            kind: 'probe',
            probe: { kind: 'file', spec: { path: 'C:/a.log' } },
            intervalMs: 1000,
            cooldownMs: 5000,
            threshold: 3,
            settleFrames: 2,
          },
        }),
      ],
      watch,
    );
    const o = watch.starts[0].options!;
    expect(o.note).toContain('监控A');
    expect(o.intervalMs).toBe(1000);
    expect(o.cooldownMs).toBe(5000);
    expect(o.threshold).toBe(3);
    expect(o.settleFrames).toBe(2);
    expect(o.once).toBe(false);
  });

  it('单条 arm 失败 → 记入 errors，其余规则照常 arm（失败隔离）', () => {
    const watch = fakeWatch({ failKinds: ['process'] });
    const res = armProbeRules(
      [
        probeRule({ id: 'p-ok', when: { kind: 'probe', probe: { kind: 'file', spec: { path: 'x' } } } }),
        probeRule({ id: 'p-bad', when: { kind: 'probe', probe: { kind: 'process', spec: {} } } }),
      ],
      watch,
    );
    expect([...res.armed.keys()]).toEqual(['p-ok']);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('p-bad');
  });
});

describe('disarmWatchIds', () => {
  it('逐个 stop 全部 watchId', () => {
    const watch = fakeWatch();
    disarmWatchIds(watch, ['w1', 'w2', 'w3']);
    expect(watch.stops).toEqual(['w1', 'w2', 'w3']);
  });

  it('单个 stop 抛错不阻断其余（热更时不能因一个坏 id 卡住）', () => {
    const watch = fakeWatch({ failStopIds: ['w2'] });
    expect(() => disarmWatchIds(watch, ['w1', 'w2', 'w3'])).not.toThrow();
    expect(watch.stops).toEqual(['w1', 'w3']); // w2 抛错跳过，w3 仍停
  });
});
