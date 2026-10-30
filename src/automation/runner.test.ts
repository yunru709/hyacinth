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

describe('runRule：resolveDeep 模板解析边界（2026-10-30 回归）', () => {
  it('以 $ 开头但不是 $event/$result 的字符串原样保留（命令不能被当模板吃掉）', async () => {
    let got: Record<string, unknown> = {};
    const c = ctx({ invokeTool: async (_t, a) => { got = a; return 'ok'; } });
    const cmd = "$f='x'; echo $f";
    await runRule(rule({ do: [{ sink: 'invoke', tool: 'bash', args: { command: cmd } }] }), event, c);
    expect(got.command).toBe(cmd); // 原样，未被 pickPath 吃成 undefined
  });

  it('同一 args 内 $event.* 仍被正常解析（对照：证明不是整体跳过解析）', async () => {
    let got: Record<string, unknown> = {};
    const c = ctx({ invokeTool: async (_t, a) => { got = a; return 'ok'; } });
    await runRule(
      rule({ do: [{ sink: 'invoke', tool: 'x', args: { plain: '$f=1', fromEvent: '$event.name' } }] }),
      event,
      c,
    );
    expect(got.plain).toBe('$f=1');        // 非模板 → 原样
    expect(got.fromEvent).toBe('微信监控'); // 模板 → 取 event.name
  });

  it('嵌套对象/数组里的非模板 $ 字符串也保持原样', async () => {
    let got: Record<string, unknown> = {};
    const c = ctx({ invokeTool: async (_t, a) => { got = a; return 'ok'; } });
    await runRule(
      rule({ do: [{ sink: 'invoke', tool: 'x', args: { list: ['$a', '$event.name'], obj: { k: '$b' } } }] }),
      event,
      c,
    );
    expect(got.list).toEqual(['$a', '微信监控']);
    expect(got.obj).toEqual({ k: '$b' });
  });
});

describe('runRule：loop 退出原因（R1 回归，2026-10-31）', () => {
  it('times 跑满（< cap）→ ok:true', async () => {
    const c = ctx({ invokeTool: vi.fn(async () => 'ok') });
    const res = await runRule(
      rule({ do: [{ sink: 'loop', times: 2, do: [{ sink: 'invoke', tool: 'x' }] }] }),
      event,
      c,
    );
    expect(res.ok).toBe(true);
  });

  it('times=10 + until 第 1 轮即满足 → ok:true，且 loop 之后的动作继续执行', async () => {
    // 「后续动作继续执行」必须显式断言：原 bug 的实际伤害是误判截断 → abort 跳过后续动作，
    // 只断言 ok:true 钉不住这个伤害（2026-10-31 复核改进）。
    const executed: string[] = [];
    const c = ctx({
      invokeTool: vi.fn(async (tool) => {
        executed.push(tool);
        return 'ok';
      }),
    });
    const res = await runRule(
      rule({
        do: [
          {
            sink: 'loop',
            times: 10,
            until: { path: 'result', op: '!=', value: 'IMPOSSIBLE__' },
            do: [{ sink: 'invoke', tool: 'loopBody' }],
          },
          { sink: 'invoke', tool: 'afterLoop' },
        ],
      }),
      event,
      c,
    );
    expect(res.ok).toBe(true);
    // 强断言：直接取 loop step 的 output（JSON.stringify 全量搜索任何 step 含该子串都过）
    expect(res.steps.find((s) => s.sink === 'loop')?.output).toBe('iterations=1');
    expect(executed).toEqual(['loopBody', 'afterLoop']);
  });

  it('times=10 + while 第 2 轮不满足 → ok:true，后续动作继续执行（while 退出路径）', async () => {
    // while 与 until 走的是不同的 break 行（runner.ts 判定顺序：times → until → while），
    // 必须单独钉住：第 2 轮 while 条件不成立 ⇒ 提前退出且不算截断。
    const executed: string[] = [];
    let bodyRuns = 0;
    const c = ctx({
      invokeTool: async (tool) => {
        executed.push(tool);
        if (tool !== 'loopBody') return 'ok';
        bodyRuns++;
        // 第 2 轮返回哨兵值 ⇒ while（result != STOP__）在本轮结束后不成立
        return bodyRuns === 2 ? 'STOP__' : 'ok';
      },
    });
    const res = await runRule(
      rule({
        do: [
          {
            sink: 'loop',
            times: 10,
            while: { path: 'result', op: '!=', value: 'STOP__' },
            do: [{ sink: 'invoke', tool: 'loopBody' }],
          },
          { sink: 'invoke', tool: 'afterLoop' },
        ],
      }),
      event,
      c,
    );
    expect(res.ok).toBe(true);
    expect(res.steps.find((s) => s.sink === 'loop')?.output).toBe('iterations=2');
    expect(executed).toEqual(['loopBody', 'loopBody', 'afterLoop']);
  });

  it('times=1000 = cap → ok:true（>= 边界；exitedByCap 标记次序被破坏时此测试报警）', async () => {
    // 次序敏感：exitedByCap 只能在三个 break 判断**之后**标记。若重构把它移到 break 之前
    // （或收紧截断判定），times=cap 会被误判为截断失败 —— 此用例就是护栏。
    const c = ctx({ invokeTool: vi.fn(async () => 'ok') });
    const res = await runRule(
      rule({ do: [{ sink: 'loop', times: 1000, do: [{ sink: 'invoke', tool: 'x' }] }] }),
      event,
      c,
    );
    expect(res.ok).toBe(true);
    expect(res.steps.find((s) => s.sink === 'loop')?.output).toBe('iterations=1000');
  });

  it('times=5000 超过 cap=1000 且无条件退出 → ok:false，error 含「上限」', async () => {
    const c = ctx({ invokeTool: vi.fn(async () => 'ok') });
    const res = await runRule(
      rule({ do: [{ sink: 'loop', times: 5000, do: [{ sink: 'invoke', tool: 'x' }] }] }),
      event,
      c,
    );
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => s.sink === 'loop')?.error).toContain('上限');
  });
});
