import { describe, it, expect } from 'vitest';
import { createLoopHookBus, LOOP_HOOK_NAMES } from './loop-hooks.js';

describe('loop-hooks 声明表', () => {
  it('LOOP_HOOK_NAMES 覆盖 10 个钩子点', () => {
    expect(LOOP_HOOK_NAMES).toHaveLength(10);
    expect(new Set(LOOP_HOOK_NAMES).size).toBe(10); // 无重复
  });

  it('总线可注册/触发全部钩子点（命名即位置）', async () => {
    const bus = createLoopHookBus();
    const fired: string[] = [];

    for (const name of LOOP_HOOK_NAMES) {
      bus.on(name, () => { fired.push(name); });
    }

    await bus.emit('onTurnStart', { turn: 1 });
    await bus.emit('beforeContextAssemble', { turn: 1, userInput: 'hi', history: [], toolNames: [] });
    await bus.emit('afterContextAssemble', { turn: 1, messages: [], tokens: 0 });
    await bus.emit('onStreamEvent', { turn: 1, event: {} });
    await bus.emit('beforeToolExecute', { turn: 1, calls: [] });
    await bus.emit('afterToolExecute', { turn: 1, results: [] });
    await bus.emit('beforeIterationEnd', { turn: 1, stop: false });
    await bus.emit('onIterationEnd', { turn: 1, stop: false });
    await bus.emit('onTurnEnd', { turn: 1, tokensUsed: 0 });
    await bus.emit('onTurnError', { turn: 1, error: new Error('x') });

    expect(fired).toEqual([...LOOP_HOOK_NAMES]);
  });

  it('拦截器可短路 beforeToolExecute（权限链的挂载形态）', async () => {
    const bus = createLoopHookBus();
    bus.intercept('beforeToolExecute', async (p) => ({ ...p, calls: p.calls.filter((c) => c.name !== 'bash') }));

    const out = await bus.run(
      'beforeToolExecute',
      { turn: 1, calls: [{ name: 'read', input: {} } as never, { name: 'bash', input: {} } as never] },
      (p) => p,
    );

    expect(out.calls.map((c) => (c as { name: string }).name)).toEqual(['read']);
  });
});
