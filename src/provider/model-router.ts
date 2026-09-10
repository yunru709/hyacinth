import type { Provider } from './interface.js';
import type { Message, StreamEvent, ToolDefinition } from '../types.js';
import { ModelChannelRegistry } from './model-channel-registry.js';
import type { ModelChannelsConfig } from './model-channel-registry.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('model-router');

export type ModelRole = 'assessment' | 'planning' | 'compression' | string;

export interface ModelSourceConfig {
  source: 'main' | 'local';
  model?: string;
}

export interface ModelsConfig {
  assessment: ModelSourceConfig;
  planning: ModelSourceConfig;
  compression: ModelSourceConfig;
}

export interface LocalModelConfig {
  baseUrl?: string;
  defaultModel?: string;
}

const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  assessment: { source: 'main' },
  planning: { source: 'main' },
  compression: { source: 'main' },
};

/**
 * ModelRouter — N 通道模型路由系统。
 *
 * 根据角色返回对应的 Provider。内部委托给 ModelChannelRegistry，
 * 后者管理 .agent/model-channels.json 配置文件。
 *
 * 向后兼容：无配置文件时自动从 legacy models + provider 配置构建双通道。
 */
export class ModelRouter {
  private registry: ModelChannelRegistry;
  private mainProvider: Provider;
  private modelsConfig: ModelsConfig;
  private localConfig: LocalModelConfig;

  constructor(
    mainProvider: Provider,
    modelsConfig?: ModelsConfig,
    localConfig?: LocalModelConfig,
    registry?: ModelChannelRegistry,
  ) {
    this.mainProvider = mainProvider;
    this.modelsConfig = modelsConfig ?? DEFAULT_MODELS_CONFIG;
    this.localConfig = localConfig ?? {};

    // 使用外部传入的 registry，否则从 legacy 构建
    this.registry = registry ?? ModelChannelRegistry.fromLegacy(
      mainProvider,
      this.modelsConfig,
      this.localConfig,
    );
  }

  /**
   * 注入外部 ModelChannelRegistry（从 factory.ts 初始化后调用）。
   * 调用后 registry 接管通道管理，本地的 modelsConfig/localConfig 不再使用。
   */
  setRegistry(registry: ModelChannelRegistry): void {
    this.registry = registry;
  }

  /**
   * 根据角色返回对应的 Provider。
   * 委托给 ModelChannelRegistry，自动包含降级逻辑。
   */
  getProvider(role: ModelRole): Provider {
    const provider = this.registry.getProvider(role);
    if (provider) return provider;
    // 最终 fallback
    logger.warn(`No provider for role "${role}", falling back to main`);
    return this.mainProvider;
  }

  /**
   * 按角色现建一个带独立 userId 的短命 Provider（不写入通道实例表）。
   *
   * 用途：独立于主 loop 的 LLM 调用方（压缩器/子 Agent 等）实现
   * DeepSeek user_id 的 session/实例级 KVCache 隔离——调用方每次
   * 现取，用后即弃；通道配置（provider/model/key）仍由角色表统一管理。
   * 角色无可用通道时返回 null（调用方决定降级）。
   */
  createScopedProvider(role: ModelRole, userId: string): Provider | null {
    return this.registry.createScopedProvider(role, userId);
  }

  /**
   * 热重载配置：尝试从 model-channels.json 重载，
   * 若无文件则从 legacy config 重建。
   */
  setConfig(modelsConfig?: ModelsConfig, localConfig?: LocalModelConfig): void {
    if (modelsConfig) this.modelsConfig = modelsConfig;
    if (localConfig) this.localConfig = localConfig;
    // 尝试从 disk 重载，若无文件则从 legacy 重建
    this.registry.reload(this.mainProvider);
    // 如果 reload 没有找到文件，registry 保持原状，此时用 legacy 覆盖
    if (this.registry.listChannelNames().length === 0) {
      this.registry.buildFromLegacy(this.modelsConfig, this.localConfig);
      this.registry.initializeChannels();
    }
  }

  /**
   * 热重载通道配置（直接从 ModelChannelsConfig 对象）。
   */
  reloadChannels(config: ModelChannelsConfig): void {
    this.registry.reloadFromConfig(config, this.mainProvider);
  }

  /**
   * 主 Provider 切换时更新引用。
   */
  setMainProvider(provider: Provider, providerType?: string): void {
    this.mainProvider = provider;
    this.registry.setMainProvider(provider, providerType);
  }

  /** 获取底层 registry（供外部查询） */
  getRegistry(): ModelChannelRegistry {
    return this.registry;
  }

  /** 直接通过通道名获取 Provider（不经过角色映射） */
  getChannelProvider(name: string): Provider | null {
    return this.registry.getChannelProvider(name);
  }
}
