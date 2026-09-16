/**
 * loop-provider.test.ts —— subscribeConfig 的 routeMode 投影回归测试。
 *
 * 背景（治本所修的 bug）：configCenter.watch 只在「变更」时回调，而启动路径里
 * RuntimeConfigCenter.initialize(defaults) + merge(cfg) 的 diff 发生在 watch 注册
 * 之前（loop 创建晚于配置装配）—— 此时 routeMode 早已是最终值 manual，变更事件被
 * 永久错过 → ProviderRouter.defaultName 停留 null → 每轮 loop.route() 按
 * 「medium → 优先本地 / 无则取注册表第一个」抢走用户选择，导致重启后持久化的
 * provider.active 静默回退。
 *
 * 本测试锁定「注册订阅即按当前值应用一次」的电平触发行为。
 */
import { describe, it, expect } from 'vitest';
import { subscribeConfig, type ProviderDeps } from './loop-provider.js';
import { ProviderRouter } from '../provider/router.js';
import type { Provider } from '../provider/interface.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';

/** 最小 Provider 假件：仅实现路由/本地判定所需方法 */
function fakeProvider(type: string, model = 'm'): Provider {
  return {
    getProviderType: () => type,
    getModel: () => model,
    getCapabilities: () => ({ isLocal: false }),
  } as unknown as Provider;
}

/** 最小 configCenter 假件：记录 watch 回调，get 走静态表，可手动 _emit */
function fakeConfigCenter(values: Record<string, unknown>) {
  const watchers = new Map<string, (e: { path: string; newValue: unknown }) => void>();
  return {
    get: (path: string) => values[path],
    watch: (path: string, cb: (e: { path: string; newValue: unknown }) => void) => {
      watchers.set(path, cb);
      return () => watchers.delete(path);
    },
    _emit: (path: string, newValue: unknown) => watchers.get(path)?.({ path, newValue }),
    _watcherCount: () => watchers.size,
  };
}

function makeDeps(router: ProviderRouter, cc: unknown): ProviderDeps {
  const p = fakeProvider('volcengine');
  return {
    providerRouter: router,
    configCenter: cc as RuntimeConfigCenter,
    outputHandler: null,
    getProvider: () => p,
    getActiveProvider: () => p,
    getLastContextTokens: () => 0,
    getCurrentMaxContextTokens: () => 1000,
    getSessionDir: () => '',
  };
}

const hooks = {
  switchProvider: async () => {},
  setMaxTurns: () => {},
  setMaxContextTokens: () => {},
};

describe('subscribeConfig — routeMode 电平触发（重启后持久化选择不丢失）', () => {
  it('启动时 routeMode 已是 manual → 注册即钉住 provider.active（按类型名注册）', () => {
    const router = new ProviderRouter();
    router.register('volcengine', fakeProvider('volcengine'));
    const cc = fakeConfigCenter({ 'provider.routeMode': 'manual', 'provider.active': 'volcengine' });

    subscribeConfig(makeDeps(router, cc), hooks);

    const info = router.getRoutingInfo();
    expect(info.mode).toBe('manual');
    expect(info.providerName).toBe('volcengine');
  });

  it('启动初期仅注册 main → 回退钉 main（按构造等价于钉 provider.active）', () => {
    const router = new ProviderRouter();
    router.register('main', fakeProvider('volcengine'));
    const cc = fakeConfigCenter({ 'provider.routeMode': 'manual', 'provider.active': 'volcengine' });

    subscribeConfig(makeDeps(router, cc), hooks);

    expect(router.getRoutingInfo().mode).toBe('manual');
    // 关键回归：manual 下 route() 必须返回被钉住的实例，而非自动路由兜底
    expect(router.route({ complexity: 'medium' })).toBe(router.get('main'));
  });

  it('manual 时 route() 不再抢回注册表第一个 Provider（核心回归）', () => {
    const router = new ProviderRouter();
    // 'other' 先注册 → 自动路由 entries[0] 会选中它
    router.register('other', fakeProvider('openai'));
    router.register('volcengine', fakeProvider('volcengine'));
    const cc = fakeConfigCenter({ 'provider.routeMode': 'manual', 'provider.active': 'volcengine' });

    subscribeConfig(makeDeps(router, cc), hooks);

    // 未修复前：defaultName=null → route() 返回 entries[0]='other'（模型静默回退）
    expect(router.route({ complexity: 'medium' }).getProviderType()).toBe('volcengine');
  });

  it('routeMode=auto → 清除钉住，回到自动路由', () => {
    const router = new ProviderRouter();
    router.register('main', fakeProvider('volcengine'));
    router.setDefault('main');
    const cc = fakeConfigCenter({ 'provider.routeMode': 'auto' });

    subscribeConfig(makeDeps(router, cc), hooks);

    expect(router.getRoutingInfo().mode).toBe('auto');
  });

  it('运行时由 auto 切到 manual → 变更回调仍然生效', () => {
    const router = new ProviderRouter();
    router.register('main', fakeProvider('volcengine'));
    const cc = fakeConfigCenter({ 'provider.routeMode': 'auto', 'provider.active': 'volcengine' });

    subscribeConfig(makeDeps(router, cc), hooks);
    expect(router.getRoutingInfo().mode).toBe('auto');

    cc._emit('provider.routeMode', 'manual');
    expect(router.getRoutingInfo().mode).toBe('manual');
  });

  it('缺少 provider.active 时 manual 不误钉（保持自动路由，不抛错）', () => {
    const router = new ProviderRouter();
    router.register('main', fakeProvider('volcengine'));
    const cc = fakeConfigCenter({ 'provider.routeMode': 'manual' });

    expect(() => subscribeConfig(makeDeps(router, cc), hooks)).not.toThrow();
    expect(router.getRoutingInfo().mode).toBe('auto');
  });
});

/**
 * 守卫（2026-09-17）：配置驱动的自动切换失败时，必须把底层错误原因带进状态栏。
 *
 * 背景：旧实现 `.catch(() => { ... })` 丢弃 err，只报
 * `Config changed provider to "X" but switch failed`。用户实际遇到的是
 * 「config 里 provider.active = openai，但环境没有 OPENAI_API_KEY」→
 * tryCreateProviderFromConfig 返回 undefined → switchProvider 抛
 * `Provider "openai" not found`，而这句话在旧实现里被吞掉，导致只能靠翻源码定位。
 */
describe('subscribeConfig — 切换失败必须带出真实原因（不再吞 err.message）', () => {
  it('provider.active 变更触发切换失败 → onStatus 文案包含底层 message', async () => {
    const router = new ProviderRouter();
    router.register('main', fakeProvider('volcengine'));
    const cc = fakeConfigCenter({
      'provider.routeMode': 'auto',
      'provider.active': 'volcengine',
      'provider.openai.model': 'gpt-5.5',
    });

    const calls: string[] = [];
    const deps: ProviderDeps = {
      ...makeDeps(router, cc),
      outputHandler: {
        onStatus: (message: string, level?: string) => {
          calls.push(`${level ?? 'info'}:${message}`);
        },
      } as ProviderDeps['outputHandler'],
    };

    subscribeConfig(deps, {
      ...hooks,
      switchProvider: async () => {
        throw new Error('Provider "openai" not found. Available in router: main.');
      },
    });

    // 当前 provider 类型是 volcengine，故 'openai' 不会被同类型守卫挡掉
    cc._emit('provider.active', 'openai');
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('error:');
    expect(calls[0]).toContain('Config changed provider to "openai" but switch failed');
    // 核心回归：真实原因（缺 key → Provider not found）必须在文案里
    expect(calls[0]).toContain('Provider "openai" not found');
  });
});
