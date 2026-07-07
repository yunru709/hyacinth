import type { ProviderType, ProviderConfig } from '../types.js';
import type { Provider } from './interface.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { createDeepSeekProvider, createDeepSeekFromConfig } from './deepseek.js';
import { LocalProvider } from './local.js';
import {
  createGroqProvider,
  createXAIProvider,
  createMistralProvider,
  createOpenRouterProvider,
  createMoonshotProvider,
} from './compatible.js';
import { GeminiProvider } from './gemini.js';
import { createQwenProvider, createQwenFromConfig } from './qwen.js';
import { createZhipuProvider, createZhipuFromConfig } from './zhipu.js';
import { createMiniMaxProvider, createMiniMaxFromConfig } from './minimax.js';
import { createMiMoProvider, createMiMoFromConfig } from './mimo.js';
import { ResilientProvider } from './resilient.js';
import type { RetryConfig, CircuitBreakerConfig } from './resilient.js';
import { FallbackProviderChain } from './fallback.js';
import type { FallbackChainConfig } from './fallback.js';
import { ConfigManager } from '../setup/config.js';
import { getProviderConfigLoader } from './config.js';
import { getLocalProviderConfigLoader } from './local-config.js';

export interface ProviderManagerOptions {
  /** Override retry configuration */
  retry?: Partial<RetryConfig>;
  /** Override circuit breaker configuration */
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  /** Fallback provider types (tried in order after primary fails) */
  fallbackProviders?: ProviderType[];
  /**
   * Called when the fallback chain switches from one provider to the next.
   * Use this to adapt maxContextTokens, cache strategy, etc. for the new provider.
   */
  onFallback?: (fromType: ProviderType, toType: ProviderType, error: Error) => void;
}

/**
 * ProviderManager — 根据配置和环境变量自动选择可用的 Provider。
 *
 * 优先级：显式配置 > 环境变量自动检测
 *
 * 自动检测逻辑（按优先级排列）：
 *   有 ANTHROPIC_API_KEY → anthropic
 *   有 OPENAI_API_KEY    → openai
 *   有 DEEPSEEK_API_KEY  → deepseek
 *   有 GROQ_API_KEY      → groq
 *   有 XAI_API_KEY       → xai
 *   有 MISTRAL_API_KEY   → mistral
 *   有 GEMINI_API_KEY    → gemini
 *   有 OPENROUTER_API_KEY → openrouter
 *   有 MOONSHOT_API_KEY  → moonshot
 */
export class ProviderManager {
  private provider: Provider;
  private options?: ProviderManagerOptions;
  /** Track the resolved fallback types so switchProvider can rebuild the chain. */
  private resolvedFallbackTypes: ProviderType[] = [];

  constructor(config?: ProviderConfig, options?: ProviderManagerOptions) {
    this.options = options;

    const primary = config
      ? ProviderManager.createProviderFromConfig(config)
      : ProviderManager.detectFromEnv();

    if (!primary) {
      throw new Error(
        'No provider configuration found. ' +
          'Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, ' +
          'GROQ_API_KEY, XAI_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY, ' +
          'OPENROUTER_API_KEY, MOONSHOT_API_KEY, DASHSCOPE_API_KEY, ' +
          'ZHIPU_API_KEY, MINIMAX_API_KEY, or MIMO_API_KEY environment variable.',
      );
    }

    this.provider = this.wrapProvider(primary);
  }

  /**
   * 包装一个裸 Provider，使其具备弹性层。
   * 与构造函数中的包装逻辑完全一致，确保 switchProvider 切换后不丢失保护。
   */
  private wrapProvider(primary: Provider): Provider {
    const retry = this.options?.retry;
    const cb = this.options?.circuitBreaker;
    const onFallback = this.options?.onFallback;

    // ── 显式 fallback 链 ──
    const fallbackTypes = this.options?.fallbackProviders ?? [];
    if (fallbackTypes.length > 0) {
      const fallbackProviders = this.buildFallbackProviders(fallbackTypes);
      return new FallbackProviderChain({
        providers: [primary, ...fallbackProviders],
        retry,
        circuitBreaker: cb,
        onFallback: onFallback
          ? (from, to, err) => onFallback(from.getProviderType(), to.getProviderType(), err)
          : undefined,
      });
    }

    // ── 自动检测 fallback（排除主 provider）─
    // 只在首次构造时解析一次，避免每次 switchProvider 都重新扫描环境变量。
    if (this.resolvedFallbackTypes.length === 0) {
      const allTypes = ProviderManager.getAvailableProviders();
      const primaryType = primary.getProviderType();
      this.resolvedFallbackTypes = allTypes.filter(t => t !== primaryType);
    }

    if (this.resolvedFallbackTypes.length > 0) {
      const autoFallbacks = this.buildFallbackProviders(this.resolvedFallbackTypes);
      if (autoFallbacks.length > 0) {
        return new FallbackProviderChain({
          providers: [primary, ...autoFallbacks],
          retry,
          circuitBreaker: cb,
          onFallback: onFallback
            ? (from, to, err) => onFallback(from.getProviderType(), to.getProviderType(), err)
            : undefined,
        });
      }
    }

    // ── 单 Provider：仅包装 ResilientProvider ──
    return new ResilientProvider(primary, retry, cb);
  }

  /** Build fallback providers from their types. Skips online providers without API key. */
  private buildFallbackProviders(types: ProviderType[]): Provider[] {
    const result: Provider[] = [];
    for (const type of types) {
      // 本地模型：读取配置
      if (type === 'local' || type === 'llamacpp' || type === 'ollama') {
        try {
          const localCfg = getLocalProviderConfigLoader();
          if (localCfg?.defaultModel) {
            result.push(new LocalProvider({
              baseUrl: localCfg.baseUrl,
              model: localCfg.defaultModel,
            }));
          }
        } catch {
          // 配置不可用，跳过
        }
        continue;
      }

      const envKey = getProviderConfigLoader().getProvider(type)?.envKey;
      const apiKey = envKey ? process.env[envKey] : undefined;
      if (apiKey) {
        const provider = ProviderManager.createProviderFromConfig({
          type,
          apiKey,
          model: getProviderConfigLoader().getProvider(type)?.defaultModel ?? 'unknown',
        });
        result.push(provider);
      }
    }
    return result;
  }

  getProvider(): Provider {
    return this.provider;
  }

  getProviderType(): ProviderType {
    return this.provider.getProviderType();
  }

  getModel(): string {
    return this.provider.getModel();
  }

  /**
   * 设置 fallback 回调 — 当降级链中切换 Provider 时触发。
   * 用于在 ProviderManager 创建后、configCenter 就绪时绑定。
   * 仅对 FallbackProviderChain 有效；单 ResilientProvider 无降级，回调不触发。
   */
  setOnFallback(cb: (fromType: ProviderType, toType: ProviderType, error: Error) => void): void {
    if (this.provider instanceof FallbackProviderChain) {
      // FallbackProviderChain 的 providers 是 ResilientProvider[]，
      // 需要直接设置内部的 onFallback。
      // 最简单的方式：重新 wrap，用新的 onFallback。
      // 由于 wrapProvider 会重建整个链（包括熔断器状态），我们改为
      // 直接在 provider 上暴露 setter。
      (this.provider as FallbackProviderChain).setOnFallback?.(
        (from, to, err) => cb(from.getProviderType(), to.getProviderType(), err),
      );
    }
  }

  /** 运行时切换 Provider，保留弹性层（重试 + 熔断 + 降级链）。 */
  switchProvider(config: ProviderConfig): void {
    const primary = ProviderManager.createProviderFromConfig(config);
    // 切换主 Provider 后，自动 fallback 类型需重新解析（排除新的主 provider 类型）
    const allTypes = ProviderManager.getAvailableProviders();
    this.resolvedFallbackTypes = allTypes.filter(t => t !== primary.getProviderType());
    this.provider = this.wrapProvider(primary);
  }

  static createProviderFromConfig(config: ProviderConfig): Provider {
    switch (config.type) {
      case 'anthropic':
        return new AnthropicProvider({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
        });

      case 'openai':
        return new OpenAIProvider({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
        });

      case 'deepseek':
        return createDeepSeekFromConfig(config);

      case 'local':
      case 'ollama':
        return new LocalProvider({
          baseUrl: config.baseUrl,
          model: config.model,
          backend: config.type === 'ollama' ? 'ollama' : undefined,
        });

      case 'groq':
        return createGroqProvider({ apiKey: config.apiKey, model: config.model });

      case 'xai':
        return createXAIProvider({ apiKey: config.apiKey, model: config.model });

      case 'mistral':
        return createMistralProvider({ apiKey: config.apiKey, model: config.model });

      case 'openrouter':
        return createOpenRouterProvider({ apiKey: config.apiKey, model: config.model });

      case 'gemini':
        return new GeminiProvider({ apiKey: config.apiKey, model: config.model });

      case 'moonshot':
        return createMoonshotProvider({ apiKey: config.apiKey, model: config.model });

      case 'qwen':
        return createQwenFromConfig(config);

      case 'zhipu':
        return createZhipuFromConfig(config);

      case 'minimax':
        return createMiniMaxFromConfig(config);

      case 'mimo':
        return createMiMoFromConfig(config);

      default:
        throw new Error(`Unknown provider type: ${(config as ProviderConfig).type}`);
    }
  }

  static detectFromEnv(): Provider | null {
    if (process.env.ANTHROPIC_API_KEY) {
      return new AnthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
      });
    }

    if (process.env.OPENAI_API_KEY) {
      return new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
      });
    }

    if (process.env.DEEPSEEK_API_KEY) {
      return createDeepSeekProvider({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: process.env.DEEPSEEK_BASE_URL,
      });
    }

    if (process.env.GROQ_API_KEY) {
      return createGroqProvider();
    }

    if (process.env.XAI_API_KEY) {
      return createXAIProvider();
    }

    if (process.env.MISTRAL_API_KEY) {
      return createMistralProvider();
    }

    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      return new GeminiProvider();
    }

    if (process.env.OPENROUTER_API_KEY) {
      return createOpenRouterProvider();
    }

    if (process.env.MOONSHOT_API_KEY) {
      return createMoonshotProvider();
    }

    if (process.env.DASHSCOPE_API_KEY) {
      return createQwenProvider();
    }

    if (process.env.ZHIPU_API_KEY) {
      return createZhipuProvider();
    }

    if (process.env.MINIMAX_API_KEY) {
      return createMiniMaxProvider();
    }

    if (process.env.MIMO_API_KEY) {
      return createMiMoProvider();
    }

    // 本地模型：检查是否已配置
    try {
      const localCfg = getLocalProviderConfigLoader();
      if (localCfg?.defaultModel) {
        return new LocalProvider({
          baseUrl: localCfg.baseUrl,
          model: localCfg.defaultModel,
        });
      }
    } catch { /* local config not available */ }

    return null;
  }

  static getAvailableProviders(): ProviderType[] {
    const available: ProviderType[] = [];
    if (process.env.ANTHROPIC_API_KEY) available.push('anthropic');
    if (process.env.OPENAI_API_KEY) available.push('openai');
    if (process.env.DEEPSEEK_API_KEY) available.push('deepseek');
    if (process.env.GROQ_API_KEY) available.push('groq');
    if (process.env.XAI_API_KEY) available.push('xai');
    if (process.env.MISTRAL_API_KEY) available.push('mistral');
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) available.push('gemini');
    if (process.env.OPENROUTER_API_KEY) available.push('openrouter');
    if (process.env.MOONSHOT_API_KEY) available.push('moonshot');
    if (process.env.DASHSCOPE_API_KEY) available.push('qwen');
    if (process.env.ZHIPU_API_KEY) available.push('zhipu');
    if (process.env.MINIMAX_API_KEY) available.push('minimax');
    if (process.env.MIMO_API_KEY) available.push('mimo');
    // 本地模型兜底：检测是否已配置
    try {
      const localCfg = getLocalProviderConfigLoader();
      if (localCfg?.defaultModel) {
        available.push('local');
      }
    } catch {
      // 配置不存在或无法加载，跳过
    }
    return available;
  }

  /**
   * 从配置文件创建 Provider。
   * 优先级：项目级 .env > 全局 .env > 环境变量
   * 配置合并：默认 → 全局 config.json → 项目级 config.json
   */
  static async createFromConfigFile(overrides?: Partial<ProviderConfig>, projectDir?: string): Promise<ProviderManager> {
    const configManager = new ConfigManager(projectDir);

    // 加载 .env 中的 API Key 到 process.env（全局 + 项目级）
    await configManager.loadEnvKeys();

    // 读取配置（合并层级：默认 → 全局 → 项目级）
    const agentConfig = await configManager.load();

    // 确定最终配置（兼容旧格式字符串和新格式对象）
    const rawProvider = agentConfig.provider;
    const providerType = (overrides?.type ??
      (typeof rawProvider === 'string'
        ? rawProvider
        : (rawProvider as Record<string, unknown>)?.active)) as ProviderType;

    // 优先读取 provider.<type>.model，再回退到顶层 model 字段（旧格式）
    const providerSection = typeof rawProvider === 'object' && rawProvider !== null
      ? ((rawProvider as Record<string, unknown>)[providerType] as Record<string, unknown> | undefined)
      : undefined;
    const providerModel = typeof providerSection?.model === 'string' ? providerSection.model : undefined;
    const model = overrides?.model ?? providerModel ?? agentConfig.model;

    // 获取 API Key
    const apiKey = overrides?.apiKey ?? process.env[configManager.getApiKeyEnvName(providerType) ?? ''] ?? '';

    const config: ProviderConfig = {
      type: providerType,
      apiKey,
      model,
      baseUrl: overrides?.baseUrl,
    };

    return new ProviderManager(config, {
      retry: agentConfig.retry,
      circuitBreaker: agentConfig.circuitBreaker,
      fallbackProviders: agentConfig.fallbackProviders as ProviderType[] | undefined,
    });
  }
}
