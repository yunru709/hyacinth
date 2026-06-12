import type { Provider } from './interface.js';
import type { Message, StreamEvent, ToolDefinition } from '../types.js';
import { LocalProvider } from './local.js';
import { createLogger } from '../logging/logger.js';
import { getLocalProviderConfigLoader } from './local-config.js';

const logger = createLogger('model-router');

export type ModelRole = 'assessment' | 'planning' | 'compression';

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

const DEFAULT_LOCAL_CONFIG: LocalModelConfig = getLocalProviderConfigLoader();

/**
 * ModelRouter — 双通道模型路由系统。
 *
 * 根据角色（assessment / planning / compression）返回对应的 Provider：
 * - source='main' → 返回主 Provider
 * - source='local' → 返回 LocalProvider（失败时自动降级到主 Provider）
 */
export class ModelRouter {
  private mainProvider: Provider;
  private modelsConfig: ModelsConfig;
  private localConfig: LocalModelConfig;
  private localProviders: Map<ModelRole, Provider> = new Map();

  constructor(
    mainProvider: Provider,
    modelsConfig?: ModelsConfig,
    localConfig?: LocalModelConfig,
  ) {
    this.mainProvider = mainProvider;
    this.modelsConfig = modelsConfig ?? DEFAULT_MODELS_CONFIG;
    this.localConfig = localConfig ?? DEFAULT_LOCAL_CONFIG;
  }

  /**
   * 根据角色返回对应的 Provider。
   *
   * source='main' → 主 Provider
   * source='local' → LocalProvider（创建/复用，失败时自动降级到主 Provider）
   */
  getProvider(role: ModelRole): Provider {
    const config = this.modelsConfig[role];
    if (config.source === 'main') {
      return this.mainProvider;
    }
    return this.getOrCreateLocalProvider(role, config);
  }

  /**
   * 热重载配置 — 清除本地 Provider 缓存。
   */
  setConfig(modelsConfig: ModelsConfig, localConfig?: LocalModelConfig): void {
    this.modelsConfig = modelsConfig;
    if (localConfig) {
      this.localConfig = localConfig;
    }
    this.localProviders.clear();
  }

  /**
   * 主 Provider 切换时更新引用。
   */
  setMainProvider(provider: Provider): void {
    this.mainProvider = provider;
    this.localProviders.clear();
  }

  private getOrCreateLocalProvider(role: ModelRole, config: ModelSourceConfig): Provider {
    const cached = this.localProviders.get(role);
    if (cached) return cached;

    const model = config.model ?? this.localConfig.defaultModel;
    const localProvider = new LocalProvider({
      baseUrl: this.localConfig.baseUrl,
      model,
    });

    const fallbackProvider = this.createFallbackProvider(localProvider);
    this.localProviders.set(role, fallbackProvider);
    return fallbackProvider;
  }

  /**
   * 包装 LocalProvider：调用失败时降级到主 Provider 并记录 warning。
   */
  private createFallbackProvider(localProvider: Provider): Provider {
    const self = this;

    return {
      async *createStream(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<StreamEvent> {
        try {
          for await (const event of localProvider.createStream(messages, tools, signal)) {
            yield event;
          }
        } catch (error) {
          logger.warn(
            'Local model unavailable, falling back to main provider',
            { error: error instanceof Error ? error.message : String(error) },
          );
          for await (const event of self.mainProvider.createStream(messages, tools, signal)) {
            yield event;
          }
        }
      },

      getProviderType() {
        return localProvider.getProviderType();
      },

      getModel() {
        return localProvider.getModel();
      },

      getCapabilities() {
        return localProvider.getCapabilities?.() ?? {
          toolCalling: false,
          streaming: true,
          adapterSupport: false,
          maxContextTokens: 4096,
          isLocal: true,
          vision: false,
        };
      },
    };
  }
}