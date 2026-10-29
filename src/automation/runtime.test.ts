/**
 * AutomationRule 运行时测试（2026-10-30）
 *
 * 重点在**匹配精度**：同一 kind 下会有多个监控项（都监控日志文件的 A 和 B），
 * 只按 kind 匹配会让 A 的命中触发 B 的规则 —— 在自动化里这是灾难。
 * 所以 probe 类必须能精确到 watchId。
 */

import { describe, expect, it, vi } from 'vitest';

import { matchRules, ruleMatches, runMatchingRules } from './runtime.js';
import type { AutomationEvent } from './runtime.js';
import type { RunnerContext } from './runner.js';
import type { AutomationRule } from './types.js';

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    when: { kind: 'event', event: 'afterWatch' },
    do: [{ sink: 'invoke', tool: 'say', args: { content: 'x' } }],
    ...over,
  };
}

function ev(eventName: string): AutomationEvent {
  return { eventName, source: 'watch', name: 'n', at: Date.now(), payload: { kind: 'process' } };
}

describe('ruleMatches：event 类', () => {
  it('精确事件名匹配', () => {
    const r = rule({ when: { kind: 'event', event: 'afterToolExecute:write' } });
    expect(ruleMatches(r, ev('afterToolExecute:write'))).toBe(true);
    expect(ruleMatches(r, ev('afterToolExecute:edit'))).toBe(false);
  });

  it('前缀覆盖子事件（afterWatch 匹配 afterWatch:process）', () => {
    const r = rule({ when: { kind: 'event', event: 'afterWatch' } });
    expect(ruleMatches(r, ev('afterWatch:process'))).toBe(true);
    expect(ruleMatches(r, ev('afterWatch:file'))).toBe(true);
    expect(ruleMatches(r, ev('afterToolExecute:write'))).toBe(false);
  });

  it('disabled 的规则永不匹配', () => {
    const r = rule({ enabled: false });
    expect(ruleMatches(r, ev('afterWatch:process'))).toBe(false);
  });
});

describe('ruleMatches：probe 类（精确到 watchId）', () => {
  const probeRule = rule({
    id: 'probe-r',
    when: { kind: 'probe', probe: { kind: 'file', spec: { path: 'a.log' } } },
  });

  it('带 #id 的事件：只匹配自己 arm 的那个 watchId', () => {
    const armed = new Map([['probe-r', 'w7']]);
    expect(ruleMatches(probeRule, ev('afterWatch:file#w7'), armed)).toBe(true);
    // 同 kind、不同监控项 ⇒ 不匹配（关键：防串线）
    expect(ruleMatches(probeRule, ev('afterWatch:file#w9'), armed)).toBe(false);
  });

  it('规则没 arm 过 ⇒ 带 #id 的事件不匹配（不误触发）', () => {
    expect(ruleMatches(probeRule, ev('afterWatch:file#w7'), new Map())).toBe(false);
  });

  it('不带 #id 的宽松事件按 kind 匹配（批量/测试场景兜底）', () => {
    expect(ruleMatches(probeRule, ev('afterWatch:file'))).toBe(true);
    expect(ruleMatches(probeRule, ev('afterWatch:process'))).toBe(false);
  });
});

describe('ruleMatches：time 类', () => {
  it('按 afterTime:<ruleId> 匹配（只命中自己）', () => {
    const r = rule({ id: 'job-a', when: { kind: 'time', schedule: { intervalMs: 1000 } } });
    expect(ruleMatches(r, ev('afterTime:job-a'))).toBe(true);
    expect(ruleMatches(r, ev('afterTime:job-b'))).toBe(false);
  });
});

describe('matchRules / runMatchingRules', () => {
  it('matchRules 保持规则表顺序', () => {
    const rules = [
      rule({ id: 'a' }),
      rule({ id: 'b', enabled: false }),
      rule({ id: 'c' }),
    ];
    expect(matchRules(rules, ev('afterWatch:process')).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('runMatchingRules：一条失败不影响其它规则，且不抛错', async () => {
    const rules = [rule({ id: 'bad' }), rule({ id: 'good' })];
    const ctx: RunnerContext = {
      invokeTool: vi.fn(async (tool) => {
        if (tool === 'say') throw new Error('第一轮炸');
        return '';
      }),
      wakeSession: async () => {},
    };

    const out = await runMatchingRules(rules, ev('afterWatch:process'), ctx);
    expect(out).toHaveLength(2);
    expect(out[0].result.ok).toBe(false);
    expect(out[1].result.ok).toBe(false); // 两规则调同一工具，都会炸；重点是不抛异常
  });

  it('无匹配规则时直接返回空数组（零开销）', async () => {
    const ctx: RunnerContext = { invokeTool: vi.fn(), wakeSession: vi.fn() };
    const out = await runMatchingRules([rule({ when: { kind: 'event', event: 'onTurnEnd' } })], ev('afterWatch:process'), ctx);
    expect(out).toEqual([]);
    expect(ctx.invokeTool).not.toHaveBeenCalled();
  });
});
