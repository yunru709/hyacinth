/**
 * createScopedProvider 单测（user_id 隔离模型重构）。
 *
 * 验证：按次现建独立实例、通道实例表零污染、未知角色回退 main 配置、
 * thinking:false 透传构造。userId 的 API 侧注入由 ProviderConfig.userId
 * → createDeepSeekProvider 构造参数承载（OpenAICompatibleProvider.createStream
 * 注入 user_id 字段），此处验证 registry 层的组合行为。
 */
import { describe, it, expect, vi } from 'vitest';
import { ModelChannelRegistry } from './model-channel-registry.js';
import { getProviderConfigLoader } from './config.js';

function makeRegistry(): ModelChannelRegistry {
  // registry 工厂依赖 ProviderConfigLoader 单例（env key 解析），测试先初始化
  getProviderConfigLoader(process.cwd());
  const registry = new ModelChannelRegistry();
  // legacy 构建：main 通道 deepseek；注册 compression 角色通道（带通道默认 userId + thinking:false）
  registry.buildFromLegacy(
    { assessment: { source: 'main' }, planning: { source: 'main' }, compression: { source: 'main' } },
    undefined,
    'deepseek',
  );
  registry.initializeChannels();
  // 默认通道补 key（未知角色回退 default 通道现建用）
  registry.upsertChannel('default', { provider: 'deepseek', model: 'main-model', apiKey: 'test-key' });
  registry.upsertChannel('compression', {
    provider: 'deepseek',
    model: 'test-model',
    apiKey: 'test-key', // 工厂对空 key 抛错（生产由 env 解析）；测试给假 key 走通构造
    userId: 'hyacinth-compressor',
    thinking: false,
  });
  registry.setRoleMapping('compression', 'compression');
  return registry;
}

describe('ModelChannelRegistry.createScopedProvider', () => {
  it('每次现建新实例，不复用、不污染通道实例表', () => {
    const registry = makeRegistry();
    const channelInstance = registry.getChannelProvider('compression');

    const s1 = registry.createScopedProvider('compression', 'hyacinth-compressor-sessionA');
    const s2 = registry.createScopedProvider('compression', 'hyacinth-compressor-sessionB');

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s1).not.toBe(s2); // 每次现建
    expect(s1).not.toBe(channelInstance); // 不复用通道实例
    // 通道实例表零污染（getProvider('compression') 的长驻实例不受影响）
    expect(registry.getChannelProvider('compression')).toBe(channelInstance);
  });

  it('scoped 实例类型跟随通道配置', () => {
    const registry = makeRegistry();
    const scoped = registry.createScopedProvider('compression', 'uid')!;
    expect(scoped.getProviderType()).toBe('deepseek');
    expect(scoped.getModel()).toBe('test-model');
  });

  it('未知角色 → 回退 main 通道配置现建（仍带 scoped userId）', () => {
    const registry = makeRegistry();
    const scoped = registry.createScopedProvider('never-mapped-role', 'uid-x')!;
    expect(scoped).not.toBeNull();
    expect(scoped.getProviderType()).toBe('deepseek');
  });

  it('多次 scoped 现建不影响 getProvider(role) 的长驻解析', () => {
    const registry = makeRegistry();
    const before = registry.getProvider('compression');
    registry.createScopedProvider('compression', 'uid-1');
    registry.createScopedProvider('compression', 'uid-2');
    expect(registry.getProvider('compression')).toBe(before);
  });
});

describe('调用点自动登记（挂得上，也要看得见）', () => {
  it('没有显式映射的调用点，取过一次连接后出现在 listRoles，并显示它实际用的通道', () => {
    const registry = makeRegistry();
    expect(registry.listRoles()['some-plugin']).toBeUndefined();

    registry.getProvider('some-plugin');

    expect(registry.listRoles()['some-plugin']).toBe('default');
    expect(registry.listDiscoveredRoles()['some-plugin']).toBe('default');
  });

  it('scoped 入口登记的是「实际生效」的通道：无同名通道时落到 default', () => {
    const registry = makeRegistry();

    // 有显式映射的调用点不进"自动发现"名单
    registry.createScopedProvider('compression', 'u1');
    expect(registry.listDiscoveredRoles()['compression']).toBeUndefined();

    // 无映射、也无同名通道 → 实际吃 default
    registry.createScopedProvider('ghost-role', 'u2');
    expect(registry.listDiscoveredRoles()['ghost-role']).toBe('default');
  });

  it('不落盘：自动登记不触发 save（配置只由用户显式改）', () => {
    const registry = makeRegistry();
    const spy = vi.spyOn(registry as unknown as { save: () => void }, 'save');

    registry.getProvider('some-plugin');
    registry.createScopedProvider('another-role', 'u3');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
