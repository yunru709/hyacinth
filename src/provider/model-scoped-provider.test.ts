/**
 * createScopedProvider 单测（user_id 隔离模型重构）。
 *
 * 验证：按次现建独立实例、通道实例表零污染、未知角色回退 main 配置、
 * thinking:false 透传构造。userId 的 API 侧注入由 ProviderConfig.userId
 * → createDeepSeekProvider 构造参数承载（OpenAICompatibleProvider.createStream
 * 注入 user_id 字段），此处验证 registry 层的组合行为。
 */
import { describe, it, expect } from 'vitest';
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
  // main 通道补 key（未知角色回退 main 现建用）
  registry.upsertChannel('main', { provider: 'deepseek', model: 'main-model', apiKey: 'test-key' });
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
