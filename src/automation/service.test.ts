/**
 * automation/service 测试 —— 派发入口 + maxRuns 生命周期（2026-10-30）
 *
 * 这条链路之前**零测试**（只有 runner/validate/store/runtime/time-source/wake-adapter）。
 * 锁死的语义：
 *   1. 未装配 / 无规则 → 静默返回空数组（永不抛错，调用方是后台循环）
 *   2. 匹配置信地执行，返回逐条 outcome
 *   3. maxRuns 达上限 → 自动 enabled=false + runCount 落盘
 *   4. 失败轮次**不计** runCount
 *   5. 已停用（enabled=false）的规则不再被派发
 *
 * ⚠️ 隔离：store 的 saveAutomationRules 被 mock 成 spy，
 *    避免测试写真实的 ~/.agent/automations.json。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>();
  return { ...actual, saveAutomationRules: vi.fn() };
});

import { dispatchAutomationEvent, dispatchWatchEvent, setAutomationRuntime } from './service.js';
import type { AutomationEvent } from './runtime.js';
import { saveAutomationRules, setCurrentAutomationRules, getCurrentAutomationRules } from './store.js';
import type { AutomationRule } from './types.js';

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    when: { kind: 'event', event: 'ping' },
    do: [{ sink: 'invoke', tool: 'noop' }],
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    invokeTool: vi.fn(async () => 'ok'),
    wakeSession: vi.fn(async () => {}),
    ...over,
  } as never;
}

function ev(name = 'ping'): AutomationEvent {
  return { eventName: name, source: 'test', name: 'x', at: Date.now(), payload: {} };
}

beforeEach(() => {
  setCurrentAutomationRules([]);
  setAutomationRuntime(null);
  vi.mocked(saveAutomationRules).mockClear();
});

describe('dispatchAutomationEvent：装配与匹配', () => {
  it('未装配 runtime → 返回空数组（静默，不抛错）', async () => {
    setCurrentAutomationRules([rule()]);
    await expect(dispatchAutomationEvent(ev())).resolves.toEqual([]);
  });

  it('无规则 → 空数组', async () => {
    setAutomationRuntime(deps());
    await expect(dispatchAutomationEvent(ev())).resolves.toEqual([]);
  });

  it('匹配事件 → 执行并返回 outcome（invoke 被调用）', async () => {
    const d = deps();
    setCurrentAutomationRules([rule()]);
    setAutomationRuntime(d);
    const out = await dispatchAutomationEvent(ev());
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe('r1');
    expect(out[0].result.ok).toBe(true);
    expect((d as any).invokeTool).toHaveBeenCalledWith('noop', {});
  });

  it('事件名不匹配 → 空数组', async () => {
    setAutomationRuntime(deps());
    setCurrentAutomationRules([rule()]);
    await expect(dispatchAutomationEvent(ev('other'))).resolves.toEqual([]);
  });

  it('dispatchWatchEvent 拼出 afterWatch:<kind>#<id> 并能精确匹配 probe 规则', async () => {
    const d = deps();
    setCurrentAutomationRules([
      rule({
        id: 'p1',
        when: { kind: 'probe', probe: { kind: 'file', spec: { path: 'x' } } },
      }),
    ]);
    setAutomationRuntime({ ...(d as object), armedWatchIds: new Map([['p1', 'w1']]) } as never);
    const out = await dispatchWatchEvent('file', 'w1');
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe('p1');
  });
});

describe('dispatchAutomationEvent：maxRuns 生命周期', () => {
  it('成功执行后 runCount+1，达到 maxRuns 自动停用并落盘', async () => {
    setAutomationRuntime(deps());
    setCurrentAutomationRules([rule({ maxRuns: 2, runCount: 0 })]);

    await dispatchAutomationEvent(ev());
    let r = getCurrentAutomationRules()[0];
    expect(r.runCount).toBe(1);
    expect(r.enabled).toBe(true); // 还没到上限

    await dispatchAutomationEvent(ev());
    r = getCurrentAutomationRules()[0];
    expect(r.runCount).toBe(2);
    expect(r.enabled).toBe(false); // 达到上限 → 停用
    expect(vi.mocked(saveAutomationRules)).toHaveBeenCalledTimes(2); // 每次都落盘
  });

  it('停用后不再被派发（enabled=false 被 ruleMatches 过滤）', async () => {
    const d = deps();
    setAutomationRuntime(d);
    setCurrentAutomationRules([rule({ maxRuns: 1 })]);
    await dispatchAutomationEvent(ev()); // 这一次到上限，停用
    const out = await dispatchAutomationEvent(ev()); // 再派发
    expect(out).toEqual([]);
    expect((d as any).invokeTool).toHaveBeenCalledTimes(1);
  });

  it('失败轮次不计 runCount（只计成功）', async () => {
    const d = deps({ invokeTool: vi.fn(async () => { throw new Error('boom'); }) });
    setAutomationRuntime(d);
    setCurrentAutomationRules([rule({ maxRuns: 5, runCount: 0 })]);
    await dispatchAutomationEvent(ev());
    expect(getCurrentAutomationRules()[0].runCount ?? 0).toBe(0); // 失败不累加
  });
});
