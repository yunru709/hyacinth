/**
 * P1 M7 · 插件挂载主循环验证（等价装配）。
 *
 * AgentLoop 构造的真实装配形态就是：
 *   this.loopHooks = createLoopHookBus();
 *   this.pluginHost = new PluginHost({ hooks: this.loopHooks });
 * 本测试用同样的装配验证 P1 承诺的闭环：
 *   插件 ctx.aroundHook 拦截主循环钩子（权限链形态）→ 短路/改写 → 卸载回滚。
 */
import { describe, it, expect, vi } from 'vitest';
import { createLoopHookBus, type LoopHooks } from './loop-hooks.js';
import { PluginHost, type HyPlugin } from '../kernel/plugin-host.js';

/** 复刻 AgentLoop 构造的插件装配（loop.pluginHost = new PluginHost({ hooks: loopHooks })） */
function makeLoopPluginAssembly() {
  const bus = createLoopHookBus();
  const host = new PluginHost<Record<string, unknown>, LoopHooks>({ hooks: bus });
  return { bus, host };
}

describe('P1 M7 插件挂载主循环（等价装配）', () => {
  it('插件 aroundHook 拦截 beforeToolExecute：过滤危险工具，卸载后放行', async () => {
    const { bus, host } = makeLoopPluginAssembly();

    // 权限链插件：bash 一律不执行（拦截器不调 next = 短路）
    const permPlugin: HyPlugin<Record<string, unknown>, LoopHooks> = {
      id: 'perm-chain',
      activate(ctx) {
        ctx.aroundHook('beforeToolExecute', async (payload, next) => {
          const calls = (payload as { calls: Array<{ name: string }> }).calls;
          const filtered = calls.filter((c) => c.name !== 'bash');
          return next({ ...payload, calls: filtered } as never);
        });
      },
    };
    const disposer = await host.mount(permPlugin);

    // 挂载期：bash 被过滤
    const out1 = await bus.run(
      'beforeToolExecute',
      { turn: 1, calls: [{ id: "b1", name: "bash", input: {} }, { id: "r1", name: "read", input: {} }] },
      (p) => p,
    );
    expect(out1.calls.map((c) => (c as { name: string }).name)).toEqual(['read']);

    // 卸载：钩子随生命周期账本自动摘除 → bash 放行
    await disposer.dispose();
    const out2 = await bus.run(
      'beforeToolExecute',
      { turn: 2, calls: [{ id: "b1", name: "bash", input: {} }] },
      (p) => p,
    );
    expect(out2.calls.map((c) => (c as { name: string }).name)).toEqual(['bash']);
    expect(host.isMounted('perm-chain')).toBe(false);
  });

  it('插件 onHook 观察回合事件，卸载后订阅消失', async () => {
    const { bus, host } = makeLoopPluginAssembly();
    const spy = vi.fn();

    const observer: HyPlugin<Record<string, unknown>, LoopHooks> = {
      id: 'observer',
      activate(ctx) {
        ctx.onHook('onTurnStart', (payload) => {
          spy(payload.turn);
        });
      },
    };
    const disposer = await host.mount(observer);

    await bus.emit('onTurnStart', { turn: 1 });
    expect(spy).toHaveBeenCalledWith(1);

    await disposer.dispose();
    await bus.emit('onTurnStart', { turn: 2 });
    expect(spy).toHaveBeenCalledTimes(1); // 卸载后不再通知
  });

  it('插件注册服务可被读取，卸载回滚（三角色模型）', async () => {
    const { host } = makeLoopPluginAssembly();

    const provider: HyPlugin<Record<string, unknown>, LoopHooks> = {
      id: 'svc-provider',
      activate(ctx) {
        ctx.register('kb' as never, { search: () => 'result' } as never);
      },
    };
    await host.mount(provider);

    expect((host.get('kb') as { search: () => string } | undefined)?.search()).toBe('result');

    await host.unmount('svc-provider');
    expect(host.get('kb')).toBeUndefined(); // 服务随插件卸载回滚
  });
});
