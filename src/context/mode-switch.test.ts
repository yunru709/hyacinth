/**
 * 模式切换的**统一编排** —— 出口判定 + `null` 语义锁定。
 *
 * 背景：模式的"出口"原先在三处各自写死「回 normal」。现在只在一处判定
 * （resolveExitMode），本测试把它钉住，免得哪天又散回去 ✗。
 */
import { describe, it, expect } from 'vitest';
import { switchToMode, resolveExitMode, BUILTIN_DEFAULT_MODE } from './mode-switch.js';
import { registerRouter } from './profiles.js';
import type { IContextRouter } from './router.js';

function fakeRouter(name: string, description?: string): IContextRouter {
  return {
    name,
    description,
    toolAllowlist: [],
    toolBlacklist: [],
    skipSections: [],
    skipRuntimeSources: [],
    sourceOverrides: {},
    filterHistory: (h: unknown[]) => h,
    getTaskPrompt: () => 'prompt',
  } as unknown as IContextRouter;
}

function fakeLoop(current: string, configDefault?: string) {
  const state = { name: current, syncs: [] as string[] };
  const loop = {
    get activeRouter() {
      return { name: state.name };
    },
    async syncRouter(target?: string) {
      state.syncs.push(String(target));
      if (typeof target === 'string' && target) state.name = target;
    },
    getConfigValue: (k: string) => (k === 'startup.defaultMode' ? configDefault : undefined),
  };
  return { loop, state };
}

describe('resolveExitMode —— 「退出回到哪」只在这里判一次', () => {
  it('没有配置 → 内置兜底模式', () => {
    expect(resolveExitMode('companion', undefined)).toBe(BUILTIN_DEFAULT_MODE);
  });

  it('有配置 → 用配置值（默认模式可配置，不写死）', () => {
    expect(resolveExitMode('companion', 'coding')).toBe('coding');
  });

  it('自退出守卫：配置值 == 当前模式 ⇒ 回内置兜底（否则"退出"会变成原地重进）', () => {
    expect(resolveExitMode('companion', 'companion')).toBe(BUILTIN_DEFAULT_MODE);
  });

  it('配置是空串 / 非字符串 → 内置兜底', () => {
    expect(resolveExitMode('companion', '')).toBe(BUILTIN_DEFAULT_MODE);
    expect(resolveExitMode('companion', 42)).toBe(BUILTIN_DEFAULT_MODE);
  });
});

describe('switchToMode —— 进与出共用的唯一通道', () => {
  it('未注册的模式名 → 抛错，且错误里列出已注册模式（不静默停在旧模式）', async () => {
    registerRouter(fakeRouter('ms-known-one'));
    const { loop, state } = fakeLoop('normal');

    await expect(switchToMode(loop, 'ms-unknown-one')).rejects.toThrow(/ms-known-one/);
    expect(state.name).toBe('normal'); // 没动
  });

  it('mode = null → 回默认模式（读配置）', async () => {
    registerRouter(fakeRouter('ms-target-one'));
    const { loop, state } = fakeLoop('companion', 'ms-target-one');

    await switchToMode(loop, null);
    expect(state.name).toBe('ms-target-one');
  });

  it('已激活同一模式 → 重放生命周期（onDeactivate → onActivate），不再调 syncRouter', async () => {
    const calls: string[] = [];
    // 生产里 `loop.activeRouter` **就是**该模式的 Router 实例（loop.syncRouter 赋的），
    // 所以这里如实模拟：activeRouter === router ⇒ onDeactivate 会被真正调到。
    const router = {
      ...(fakeRouter('ms-same-one') as unknown as Record<string, unknown>),
      name: 'ms-same-one',
      async onDeactivate() { calls.push('deactivate'); },
      async onActivate() { calls.push('activate'); },
    } as unknown as IContextRouter;
    registerRouter(router);

    const loop = {
      activeRouter: router,
      async syncRouter() {
        throw new Error('已激活同模式时不应调用 syncRouter');
      },
      getConfigValue: () => undefined,
    };

    const res = await switchToMode(loop, 'ms-same-one');
    expect(res.performed).toBe(true);
    expect(calls).toEqual(['deactivate', 'activate']);
  });
});
