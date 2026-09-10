// ============================================================
// bypass 插件（整个旁路 agent 体系插件化）验收测试
// ============================================================
// 验证插件化模式：
//   1. mount 后 loop.bypassManager 被注入（原 factory 赋值等价）
//   2. 'bypass.manager' 服务可被 world-engine 插件 / factory 取回
//   3. ContextOrchestrator（普通模式旁路 agent）注册进 manager
//   4. unmount 后 loop.bypassManager 置空 + 服务消失（可逆）
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { PluginHost } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import { BypassManager } from '../bypass/manager.js';
import { createBypassPlugin, BYPASS_API_KEY, BYPASS_PLUGIN_ID } from './bypass-plugin.js';

interface Services extends Record<string, unknown> {
  'bypass.manager': BypassManager;
}
type Hooks = LoopHooks & Record<string, unknown>;

/** 最小 loop mock：只暴露 bypassManager 字段（与插件注入面一致） */
function makeLoopMock(): { bypassManager: BypassManager | undefined } {
  return { bypassManager: undefined };
}

function makePlugin(memoryFilePath = '/tmp/agent/memory.md') {
  const modelRouter = {} as never; // BypassManager.setModelRouter 只存引用，无需字段
  const loop = makeLoopMock();
  const host = new PluginHost<Services, Hooks>();
  return { host, loop, plugin: createBypassPlugin({ modelRouter, memoryFilePath, loop }) };
}

describe('bypass 插件', () => {
  it('mount 后注入 loop.bypassManager + 注册 orchestrator + 暴露服务', async () => {
    const { host, loop, plugin } = makePlugin();

    await host.mount(plugin);

    // 1. loop.bypassManager 被注入（factory 后续经它 activateForMode/activateAgent）
    expect(loop.bypassManager).toBeInstanceOf(BypassManager);

    // 2. 'bypass.manager' 服务可取回（world-engine 插件 require 依赖）
    const mgr = host.get(BYPASS_API_KEY);
    expect(mgr).toBeInstanceOf(BypassManager);

    // 3. ContextOrchestrator（普通模式旁路 agent）已注册
    const orch = mgr!.getAgent('orchestrator');
    expect(orch).toBeTruthy();
    expect(orch!.modes).toEqual(['normal']); // 普通模式旁路 agent（/orchestrator on 激活）

    // 4. 注入的是同一实例（loop 与服务的引用一致）
    expect(loop.bypassManager).toBe(mgr);

    await host.unmount(BYPASS_PLUGIN_ID);
  });

  it('unmount 后 loop.bypassManager 置空 + 服务消失（可逆）', async () => {
    const { host, loop, plugin } = makePlugin();
    await host.mount(plugin);
    expect(loop.bypassManager).toBeTruthy();

    await host.unmount(BYPASS_PLUGIN_ID);

    expect(loop.bypassManager).toBeUndefined();
    expect(host.get(BYPASS_API_KEY)).toBeUndefined();
    // loop 的 preTurn/postTurn 因 bypassManager 为空自动跳过 → 旁路功能整体消失
  });

  it('热替换：重新 mount 后注入新 manager，旧回滚不误清新值', async () => {
    const { host, loop, plugin } = makePlugin('/tmp/agent/memory-a.md');
    await host.mount(plugin);
    const first = loop.bypassManager;
    expect(first).toBeTruthy();

    // 重新 mount（同名插件会抛错，需先 unmount——模拟「卸载 → 重挂」热替换序列）
    await host.unmount(BYPASS_PLUGIN_ID);
    expect(loop.bypassManager).toBeUndefined();

    const second = makePlugin('/tmp/agent/memory-b.md');
    await second.host.mount(second.plugin);
    expect(second.loop.bypassManager).toBeTruthy();
    expect(second.loop.bypassManager).not.toBe(first);
    expect(second.loop.bypassManager).toBe(second.host.get(BYPASS_API_KEY));

    await second.host.unmount(BYPASS_PLUGIN_ID);
  });
});
