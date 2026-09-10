/**
 * 权限链插件测试 —— 插件化价值验证：
 * 真实插件（createPermissionChainPlugin）经 PluginHost 挂到主循环钩子总线，
 * aroundHook 拦截 beforeToolExecute 过滤 denyTools 黑名单。
 *
 * 装配形态与 AgentLoop 构造一致（loopHooks + PluginHost({hooks})），
 * factory 接入点：loop.mountPlugin(createPermissionChainPlugin(), { denyTools }）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createLoopHookBus, type LoopHooks } from '../orchestrator/loop-hooks.js';
import { PluginHost } from '../kernel/plugin-host.js';
import { createPermissionChainPlugin, PERMISSION_CHAIN_PLUGIN_ID } from './permission-chain.js';

const calls = (names: string[]) =>
  names.map((name, i) => ({ id: `t${i}`, name, input: {} }));

describe('permission-chain 插件（P2 插件化价值验证）', () => {
  it('denyTools 黑名单：被拒工具从调用列表移除，其余放行', async () => {
    const bus = createLoopHookBus();
    const host = new PluginHost<Record<string, unknown>, LoopHooks>({ hooks: bus });
    const warn = vi.fn();

    await host.mount(createPermissionChainPlugin(), {
      denyTools: ['rm', 'bash'],
      logger: warn,
    } as never);

    const out = await bus.run(
      'beforeToolExecute',
      { turn: 1, calls: calls(['rm', 'read', 'bash', 'write']) },
      (p) => p,
    );

    expect(out.calls.map((c: { name: string }) => c.name)).toEqual(['read', 'write']);
    expect(host.isMounted(PERMISSION_CHAIN_PLUGIN_ID)).toBe(true);
  });

  it('无 denyTools：插件空转，不注册拦截器（调用原样穿过）', async () => {
    const bus = createLoopHookBus();
    const host = new PluginHost<Record<string, unknown>, LoopHooks>({ hooks: bus });

    await host.mount(createPermissionChainPlugin()); // 无配置

    const out = await bus.run(
      'beforeToolExecute',
      { turn: 1, calls: calls(['bash', 'read']) },
      (p) => p,
    );

    expect(out.calls.map((c: { name: string }) => c.name)).toEqual(['bash', 'read']);
  });

  it('卸载：钩子随生命周期账本自动摘除，黑名单恢复放行', async () => {
    const bus = createLoopHookBus();
    const host = new PluginHost<Record<string, unknown>, LoopHooks>({ hooks: bus });

    const disposer = await host.mount(createPermissionChainPlugin(), {
      denyTools: ['rm'],
    } as never);

    // 挂载期：rm 被过滤
    const out1 = await bus.run(
      'beforeToolExecute',
      { turn: 1, calls: calls(['rm']) },
      (p) => p,
    );
    expect(out1.calls).toEqual([]);

    // 卸载：rm 放行
    await disposer.dispose();
    const out2 = await bus.run(
      'beforeToolExecute',
      { turn: 2, calls: calls(['rm']) },
      (p) => p,
    );
    expect(out2.calls.map((c: { name: string }) => c.name)).toEqual(['rm']);
    expect(host.isMounted(PERMISSION_CHAIN_PLUGIN_ID)).toBe(false);
  });
});
