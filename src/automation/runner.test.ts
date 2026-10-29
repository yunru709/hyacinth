/**
 * AutomationRule 执行器测试（2026-10-30）
 *
 * 锁死的核心语义：
 *   1. 顺序执行 + `$result.*` / `$event.*` 变量传递
 *   2. gate 分支（断言通过走 onPass、失败走 onFail）
 *   3. 失败默认 abort（物理执行链绝不能"错了还继续"）
 *   4. safety 未注入时必须**明确失败**，不能静默跳过
 */

import { describe, expect, it, vi } from 'vitest';

import type { RunnerContext } from './runner.js';
import { runRule } from './runner.js';
import type { AutomationRule } from './types.js';

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'process', spec: {} } },
    do: [],
    ...over,
  };
}

const event = {
  source: 'watch',
  name: '微信监控',
  at: Date.now(),
  payload: { kind: 'process', watchId: 'w1' },
};

function ctx(over: Partial<RunnerContext> = {}): RunnerContext {
  return {
    invokeTool: vi.fn(async () => 'ok'),
    wakeSession: vi.fn(async () => {}),
    ...over,
  };
}

describe('runRule：顺序执行与变量传递', () => {
  it('按顺序执行多个 invoke，后一步能拿到前一步结果', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const c = ctx({
      invokeTool: async (tool, args) => {
        calls.push([tool, args]);
        return tool === 'first' ? 'RESULT-1' : 'RESULT-2';
      },
    });

    const res = await runRule(
      rule({
        do: [
          { sink: 'invoke', tool: 'first', args: { a: 1 } },
          { sink: 'invoke', tool: 'second', args: { fromPrev: '$result' } },
        ],
      }),
      event,
      c,
    );

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // 第二步拿到第一步的返回值
    expect(calls[1][1].fromPrev).toBe('RESULT-1');
  });

  it('$event.* 可访问事件载荷与顶层字段', async () => {
    let seen: Record<string, unknown> = {};
    const c = ctx({
      invokeTool: async (_t, args) => {
        seen = args;
        return '';
      },
    });

    await runRule(
      rule({ do: [{ sink: 'invoke', tool: 'x', args: { k: '$event.kind', s: '$event.source' } }] }),
      event,
      c,
    );

    expect(seen.k).toBe('process'); // 来自 payload
    expect(seen.s).toBe('watch'); // 来自顶层
  });
});

describe('runRule：gate 分支', () => {
  it('断言通过 → 只走 onPass', async () => {
    const executed: string[] = [];
    const c = ctx({
      invokeTool: async (tool) => {
        executed.push(tool);
        return tool === 'check' ? '5' : '';
      },
    });

    await runRule(
      rule({
        do: [
          { sink: 'invoke', tool: 'check' },
          {
            sink: 'gate',
            assert: { path: 'result', op: '==', value: '5' },
            onPass: [{ sink: 'invoke', tool: 'passAction' }],
            onFail: [{ sink: 'invoke', tool: 'failAction' }],
          },
        ],
      }),
      event,
      c,
    );

    expect(executed).toEqual(['check', 'passAction']);
  });

  it('断言不通过 → 走 onFail（含 safety + wake）', async () => {
    const executed: string[] = [];
    const safety = vi.fn(async () => {});
    const wakeSession = vi.fn(async () => {});
    const c = ctx({
      invokeTool: async (tool) => {
        executed.push(tool);
        return '99'; // 让断言 result == '5' 失败
      },
      safety,
      wakeSession,
    });

    const res = await runRule(
      rule({
        do: [
          { sink: 'invoke', tool: 'check' },
          {
            sink: 'gate',
            assert: { path: 'result', op: '==', value: '5' },
            onPass: [{ sink: 'invoke', tool: 'passAction' }],
            onFail: [
              { sink: 'safety', action: 'hold' },
              { sink: 'wake', where: { policy: 'new' }, prompt: '处理异常' },
            ],
          },
        ],
      }),
      event,
      c,
    );

    expect(res.ok).toBe(true);
    expect(executed).toEqual(['check']); // 不走 passAction
    expect(safety).toHaveBeenCalledWith('hold');
    expect(wakeSession).toHaveBeenCalled();
  });

  it('gate 记录 asserted 结果', async () => {
    const steps: string[] = [];
    const c = ctx({
      invokeTool: async () => '7',
      record: (s) => steps.push(`${s.sink}:${String(s.asserted)}`),
    });

    await runRule(
      rule({
        do: [
          { sink: 'invoke', tool: 'x' },
          { sink: 'gate', assert: { path: 'result', op: '>', value: 5 }, onPass: [] },
        ],
      }),
      event,
      c,
    );

    expect(steps).toEqual(['invoke:undefined', 'gate:true']);
  });
});

describe('runRule：失败策略', () => {
  it('默认 abort：第一步失败，后续不执行', async () => {
    const executed: string[] = [];
    const c = ctx({
      invokeTool: async (tool) => {
        executed.push(tool);
        if (tool === 'boom') throw new Error('炸了');
        return '';
      },
    });

    const res = await runRule(
      rule({
        do: [
          { sink: 'invoke', tool: 'boom' },
          { sink: 'invoke', tool: 'never' },
        ],
      }),
      event,
      c,
    );

    expect(res.ok).toBe(false);
    expect(res.error).toBe('炸了');
    expect(executed).toEqual(['boom']);
    expect(res.steps).toHaveLength(1);
  });

  it('onError=continue：失败后继续执行后续步骤', async () => {
    const executed: string[] = [];
    const c = ctx({
      invokeTool: async (tool) => {
        executed.push(tool);
        if (tool === 'boom') throw new Error('炸了');
        return '';
      },
    });

    const res = await runRule(
      rule({
        do: [
          { sink: 'invoke', tool: 'boom' },
          { sink: 'invoke', tool: 'after' },
        ],
      }),
      event,
      c,
      { onError: 'continue' },
    );

    expect(res.ok).toBe(false);
    expect(res.error).toBe('炸了');
    expect(executed).toEqual(['boom', 'after']);
  });

  it('safety 未注入 → 明确失败（绝不静默跳过）', async () => {
    const c = ctx(); // 不提供 safety
    const res = await runRule(rule({ do: [{ sink: 'safety', action: 'stop' }] }), event, c);

    expect(res.ok).toBe(false);
    expect(res.steps[0].error).toContain('safety 未注入');
  });
});

describe('runRule：wake', () => {
  it('未给 prompt 时自动生成提示词（含事件信息）', async () => {
    let prompt = '';
    const c = ctx({
      wakeSession: async (_w, p) => {
        prompt = p;
      },
    });

    await runRule(rule({ do: [{ sink: 'wake', where: { policy: 'new' } }] }), event, c);

    expect(prompt).toContain('[Automation Trigger]');
    expect(prompt).toContain('watch');
  });

  it('wake 抛错 → 记为失败', async () => {
    const c = ctx({
      wakeSession: async () => {
        throw new Error('会话拉不起来');
      },
    });

    const res = await runRule(rule({ do: [{ sink: 'wake', where: { policy: 'new' } }] }), event, c);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('会话拉不起来');
  });
});
