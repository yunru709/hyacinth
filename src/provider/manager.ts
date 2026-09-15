import type { ProviderType, ProviderConfig } from '../types.js';
import type { Provider } from './interface.js';
import { LocalProvider } from './local.js';
import { getProviderFactory, listProviderFactories } from './factory-registry.js';
import { ResilientProvider } from './resilient.js';
import type { RetryConfig, CircuitBreakerConfig } from './resilient.js';
import { FallbackProviderChain } from './fallback.js';
import type { FallbackChainConfig, FallbackCandidate } from './fallback.js';
import { ProviderProbe } from './probe.js';
import type { ProbeConfig } from './probe.js';
import { ConfigManager } from '../setup/config.js';
import { getProviderConfigLoader } from './config.js';
import { getLocalProviderConfigLoader } from './local-config.js';
import type { ProviderFields, ProviderSampling } from './fields.js';

export interface ProviderManagerOptions {
  /** Override retry configuration */
  retry?: Partial<RetryConfig>;
  /** Override circuit breaker configuration */
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  /** Fallback provider types (tried in order after primary fails) */
  fallbackProviders?: ProviderType[];
  /** 候选探测配置（降级候选入链前先验证 API 真实可用） */
  probe?: Partial<ProbeConfig>;
  /**
   * 全部降级不可用时回到主 provider 再试一轮（默认 true）。
   * 保护长任务：宁可等待重试也不中断。
   */
  fallbackToPrimary?: boolean;
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
  /** 候选探测器单例：跨 switchProvider 存活，链重建不丢探测缓存 */
  private probe: ProviderProbe;

  constructor(config?: ProviderConfig, options?: ProviderManagerOptions) {
    this.options = options;
    this.probe = new ProviderProbe(options?.probe);

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
   *
   * 降级链成员须"真实可用"：local 三态直接实例化（静态链），在线厂商进候选池
   * （探测 API 可用后懒实例化入链，不可用者跳过）。
   */
  private wrapProvider(primary: Provider): Provider {
    const retry = this.options?.retry;
    const cb = this.options?.circuitBreaker;
    const onFallback = this.options?.onFallback;

    const staticLocal: Provider[] = [];
    const candidates: FallbackCandidate[] = [];

    // ── 显式 fallback 候选 ──
    const fallbackTypes = this.options?.fallbackProviders ?? [];
    if (fallbackTypes.length > 0) {
      this.collectFallbacks(fallbackTypes, staticLocal, candidates);
    } else {
      // ── 自动检测 fallback（排除主 provider）─
      // 只在首次构造时解析一次，避免每次 switchProvider 都重新扫描环境变量。
      if (this.resolvedFallbackTypes.length === 0) {
        const allTypes = ProviderManager.getAvailableProviders();
        const primaryType = primary.getProviderType();
        // 自动 fallback 排除本地三态（ollama/llamacpp/local）：本地服务未运行
        // 时的无条件尝试会每轮失败并触发 fallback 刷屏（detectLocalFromConfig
        // 只检查「配置有默认模型」而非「服务在跑」）。需要本地降级时请显式
        // 配置 fallbackProviders。
        this.resolvedFallbackTypes = allTypes.filter(t => {
          if (t === primaryType) return false;
          const f = getProviderFactory(t);
          return !f?.local;
        });
      }
      if (this.resolvedFallbackTypes.length > 0) {
        this.collectFallbacks(this.resolvedFallbackTypes, staticLocal, candidates);
      }
    }

    if (staticLocal.length > 0 || candidates.length > 0) {
      return new FallbackProviderChain({
        providers: [primary, ...staticLocal],
        candidates,
        probe: this.probe,
        fallbackToPrimary: this.options?.fallbackToPrimary,
        retry,
        circuitBreaker: cb,
        onFallback: onFallback
          ? (from, to, err) => onFallback(from.getProviderType(), to.getProviderType(), err)
          : undefined,
      });
    }

    // ── 单 Provider：仅包装 ResilientProvider ──
    return new ResilientProvider(primary, retry, cb);
  }

  /**
   * 收集降级候选：
   *  - local 三态（工厂标 local）→ 直接实例化进静态链（本地服务无需探测）
   *  - 在线厂商（envKey 命中）→ 进候选池，探测验证真实可用后懒实例化入链
   */
  private collectFallbacks(types: ProviderType[], staticLocal: Provider[], candidates: FallbackCandidate[]): void {
    for (const type of types) {
      const factory = getProviderFactory(type);
      if (!factory) continue;
      // 本地模型三态：读取 local-config（显式配置 fallback 用）
      if (factory.local) {
        try {
          const localCfg = getLocalProviderConfigLoader();
          if (localCfg?.defaultModel) {
            staticLocal.push(new LocalProvider({
              baseUrl: localCfg.baseUrl,
              model: localCfg.defaultModel,
            }));
          }
        } catch {
          // 配置不可用，跳过
        }
        continue;
      }

      // 在线厂商：meta 动态读取（尊重 providers.json 用户自定义 envKey/defaultModel）
      const meta = getProviderConfigLoader().getProvider(type);
      const envKey = meta?.envKey;
      const apiKey = envKey ? process.env[envKey] : undefined;
      if (apiKey && meta) {
        candidates.push({
          meta,
          apiKey,
          create: () => factory.create({
            type,
            apiKey,
            model: meta.defaultModel,
          }),
        });
      }
    }
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
    // 切换主 Provider 后，自动 fallback 类型需重新解析（排除新的主 provider 类型；
    // 同时排除本地三态，见 wrapProvider 注释——本地服务未运行时无条件尝试会刷屏）
    const allTypes = ProviderManager.getAvailableProviders();
    this.resolvedFallbackTypes = allTypes.filter(t => {
      if (t === primary.getProviderType()) return false;
      const f = getProviderFactory(t);
      return !f?.local;
    });
    this.provider = this.wrapProvider(primary);
  }

  /**
   * 从配置创建 Provider 实例 —— 注册表驱动（P5-15，方案 C）。
   * 原 15 个硬编码 switch case 已收敛至注册表（getProviderFactory 合并查询：内置 + 运行时扩展）。
   */
  static createProviderFromConfig(config: ProviderConfig): Provider {
    const factory = getProviderFactory(config.type);
    if (!factory) {
      throw new Error(`Unknown provider type: ${config.type}`);
    }
    return factory.create(config);
  }

  /**
   * 从环境变量自动检测 Provider —— 遍历注册表（键序即优先级）。
   * 原 13 个 if 链已收敛：createFromEnv 缺省（本地 ollama/llamacpp）自动跳过。
   */
  static detectFromEnv(): Provider | null {
    for (const [, factory] of listProviderFactories()) {
      const provider = factory.createFromEnv?.();
      if (provider) return provider;
    }
    return null;
  }

  /**
   * 列出当前可用的 Provider 类型 —— 遍历注册表（键序即优先级）。
   * 可用性判定：envKeys（或缺省 meta.envKey）任一存在；local 三态走 checkAvailability。
   */
  static getAvailableProviders(): ProviderType[] {
    const available: ProviderType[] = [];
    for (const [type, factory] of listProviderFactories()) {
      const isAvailable = factory.checkAvailability
        ?? (() => (factory.envKeys ?? (factory.meta ? [factory.meta.envKey] : []))
          .some((k) => k && process.env[k]));
      if (isAvailable()) {
        available.push(type as ProviderType);
      }
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

    // userId：优先从配置读取（provider.<type>.userId > provider.userId），用于 KVCache 隔离
    const providerUserId = typeof providerSection?.userId === 'string' ? providerSection.userId : undefined;
    const rawProviderObj = typeof rawProvider === 'object' && rawProvider !== null
      ? (rawProvider as Record<string, unknown>)
      : undefined;
    const fallbackUserId = rawProviderObj?.userId as string | undefined;
    const userId = overrides?.userId ?? providerUserId ?? fallbackUserId;

    // 激活配置收敛：sampling/fields/maxOutputTokens（provider.<type>.X > provider.X 顶层兜底）
    const providerSampling = (providerSection?.sampling ?? rawProviderObj?.sampling) as ProviderSampling | undefined;
    const providerFields = (providerSection?.fields ?? rawProviderObj?.fields) as ProviderFields | undefined;
    const providerMaxTokens = typeof providerSection?.maxOutputTokens === 'number'
      ? providerSection.maxOutputTokens
      : typeof rawProviderObj?.maxOutputTokens === 'number'
        ? rawProviderObj.maxOutputTokens
        : undefined;

    // 获取 API Key
    const apiKey = overrides?.apiKey ?? process.env[configManager.getApiKeyEnvName(providerType) ?? ''] ?? '';

    const config: ProviderConfig = {
      type: providerType,
      apiKey,
      model,
      baseUrl: overrides?.baseUrl,
      userId,
      maxOutputTokens: overrides?.maxOutputTokens ?? providerMaxTokens,
      fields: overrides?.fields ?? providerFields,
      sampling: overrides?.sampling ?? providerSampling,
    };

    return new ProviderManager(config, {
      retry: agentConfig.retry,
      circuitBreaker: agentConfig.circuitBreaker,
      fallbackProviders: agentConfig.fallbackProviders as ProviderType[] | undefined,
      probe: agentConfig.probe,
      fallbackToPrimary: agentConfig.fallbackToPrimary,
    });
  }
}
