import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProviderType, ProviderConfig } from '../types.js';
import type { Provider } from './interface.js';
import type { Message, StreamEvent, ToolDefinition } from '../types.js';
import { ProviderManager } from './manager.js';
import { ResilientProvider } from './resilient.js';
import { getProviderConfigLoader } from './config.js';
import { getLocalProviderConfigLoader } from './local-config.js';
import { createLogger } from '../logging/logger.js';
import type { ModelsConfig, LocalModelConfig } from './model-router.js';

const logger = createLogger('model-channel-registry');

// ── Types ──────────────────────────────────────────────────────────

export interface ChannelConfig {
  /** Provider 类型（可选，不填则继承 main 通道的 provider） */
  provider?: string;
  /** 模型名称，不填则使用 Provider 默认模型 */
  model?: string;
  /** API Key（可选，不填则从环境变量获取） */
  apiKey?: string;
  /** API Key 环境变量名（可选，不填 apiKey 则读取此环境变量） */
  apiKeyEnv?: string;
  /** API 基础 URL（可选，覆盖 Provider 默认值） */
  baseUrl?: string;
  /** DeepSeek KVCache 隔离 ID（通道级默认；scoped 调用可按次覆盖） */
  userId?: string;
  /** 是否禁用 thinking（压缩器/旁路等辅助角色置 false） */
  thinking?: boolean;
  /** 通道描述 */
  description?: string;
}

export interface ModelChannelsConfig {
  channels: Record<string, ChannelConfig>;
  roles: Record<string, string>;
}

// ── Hardcoded defaults ─────────────────────────────────────────────

/**
 * 硬编码的默认角色→通道映射。
 * 用户在 model-channels.json 中可以不写任何 roles，
 * 系统始终使用这些默认值作为兜底。
 */
const DEFAULT_ROLES: Record<string, string> = {
  assessment: 'main',
  planning: 'main',
  compression: 'main',
  'sub-agent': 'main',
};

/** 配置文件路径（项目级 .agent/model-channels.json） */
function getConfigPath(cwd: string): string {
  return path.join(cwd, '.agent', 'model-channels.json');
}

/** 全局配置文件路径（~/.agent/model-channels.json） */
function getGlobalConfigPath(): string {
  return path.join(os.homedir(), '.agent', 'model-channels.json');
}

// ── Registry ───────────────────────────────────────────────────────

export class ModelChannelRegistry {
  private configPath: string;
  private globalConfigPath: string;
  private config: ModelChannelsConfig;
  /** 通道名 → Provider 实例 */
  private channelProviders: Map<string, Provider> = new Map();
  /** 主 Provider（main 通道的 Provider，所有降级的最终 fallback） */
  private mainProvider: Provider | null = null;
  /** 用于向后兼容：老 models 配置中的 source 字段 */
  private legacyModelsConfig?: ModelsConfig;
  private legacyLocalConfig?: LocalModelConfig;
  /** 主 Provider 类型（向后兼容构建时使用） */
  private legacyProviderActive?: string;

  constructor(cwd?: string) {
    this.configPath = cwd ? getConfigPath(cwd) : '';
    this.globalConfigPath = getGlobalConfigPath();
    this.config = { channels: {}, roles: { ...DEFAULT_ROLES } };
  }

  // ── Static factories ─────────────────────────────────────────────

  /**
   * 从 legacy 配置创建 registry（向后兼容）。
   * 不读取磁盘文件，直接用传入的配置构建内存中的通道。
   */
  static fromLegacy(
    mainProvider: Provider,
    modelsConfig?: ModelsConfig,
    localConfig?: LocalModelConfig,
    providerActive?: string,
  ): ModelChannelRegistry {
    const registry = new ModelChannelRegistry();
    registry.mainProvider = mainProvider;
    registry.legacyModelsConfig = modelsConfig;
    registry.legacyLocalConfig = localConfig;
    if (providerActive) registry.legacyProviderActive = providerActive;
    registry.buildFromLegacy(modelsConfig, localConfig, providerActive);
    registry.initializeChannels();
    return registry;
  }

  // ── Init / Load ──────────────────────────────────────────────────

  /**
   * 从磁盘加载配置，合并硬编码默认值，
   * 如果文件不存在则从 legacy 配置自动构建。
   */
  load(mainProvider?: Provider, providerActive?: string): void {
    this.mainProvider = mainProvider ?? null;
    this.legacyProviderActive = providerActive;

    const loaded = this.readConfigFile();
    if (loaded) {
      this.config = this.mergeDefaults(loaded);
      logger.info('Model channels config loaded', {
        channels: Object.keys(this.config.channels),
        roles: Object.keys(this.config.roles),
      });
    } else {
      // 无配置文件 → 从 legacy 构建
      this.buildFromLegacy();
      logger.info('Model channels built from legacy config (no model-channels.json found)');
    }

    // 创建所有通道的 Provider 实例
    this.initializeChannels();
  }

  /**
   * 从 legacy 配置构建（向后兼容）。
   * 在 load() 内部无文件时自动调用，也可外部显式调用。
   */
  buildFromLegacy(
    modelsConfig?: ModelsConfig,
    localConfig?: LocalModelConfig,
    providerActive?: string,
  ): void {
    this.legacyModelsConfig = modelsConfig;
    this.legacyLocalConfig = localConfig;
    if (providerActive) this.legacyProviderActive = providerActive;

    const providerLoader = getProviderConfigLoader();
    const activeType = this.legacyProviderActive ?? 'deepseek';
    const activeMeta = providerLoader.getProvider(activeType);

    // main 通道：主 Provider
    this.config.channels['main'] = {
      provider: activeType,
      model: activeMeta?.defaultModel,
      description: '主对话通道（自动构建）',
    };

    // roles：从 legacy modelsConfig 推断
    // source='local' 的角色 → 创建以角色命名的通道（如 compression → compression 通道用 local provider）
    // source='main' 的角色 → 直接映射到 main
    this.config.roles = { ...DEFAULT_ROLES };
    if (this.legacyModelsConfig) {
      let localCfg: LocalModelConfig | null = null;
      const hasLocalRole = Object.values(this.legacyModelsConfig).some(
        (cfg) => cfg.source === 'local',
      );
      if (hasLocalRole) {
        try {
          localCfg = this.legacyLocalConfig ?? getLocalProviderConfigLoader();
        } catch {
          // getLocalProviderConfigLoader 内部有 try/catch 兜底默认值，此分支仅为防御
          localCfg = { ...getLocalProviderConfigLoader(), defaultModel: '' };
        }
      }
      for (const [role, cfg] of Object.entries(this.legacyModelsConfig)) {
        if (cfg.source === 'local' && localCfg?.defaultModel) {
          // 以角色名创建通道，provider 为 local（而非创建名为 "local" 的通道）
          this.config.channels[role] = {
            provider: 'local',
            model: localCfg.defaultModel,
            baseUrl: localCfg.baseUrl,
            description: `${role} 专用通道（local 模型）`,
          };
          this.config.roles[role] = role;
        } else {
          this.config.roles[role] = 'main';
        }
      }
    }
  }

  /**
   * 直接从配置对象重载（无需读取磁盘文件）。
   * 用于 ConfigCenter watch 回调等已有配置对象的场景。
   */
  reloadFromConfig(config: ModelChannelsConfig, mainProvider?: Provider): void {
    if (mainProvider) this.mainProvider = mainProvider;
    this.config = this.mergeDefaults(config);
    this.initializeChannels();
    logger.info('Model channels reloaded from config object', {
      channels: Object.keys(this.config.channels),
      roles: Object.keys(this.config.roles),
    });
  }

  /** 热重载：重新读取配置文件并重建所有通道 */
  reload(mainProvider?: Provider): void {
    if (mainProvider) this.mainProvider = mainProvider;

    const loaded = this.readConfigFile();
    if (!loaded) {
      logger.info('model-channels.json not found, keeping current config');
      return;
    }

    this.config = this.mergeDefaults(loaded);

    // 重建所有通道（轻量操作，Provider 实例创建开销可忽略）
    this.initializeChannels();

    logger.info('Model channels reloaded', {
      channels: Object.keys(this.config.channels),
      roles: Object.keys(this.config.roles),
    });
  }

  // ── Query ────────────────────────────────────────────────────────

  /**
   * 根据角色获取 Provider。
   * 降级链：role → channelName → channelProvider → mainProvider
   */
  getProvider(role: string): Provider | null {
    const channelName = this.config.roles[role] ?? 'main';
    const provider = this.channelProviders.get(channelName);

    if (!provider) {
      logger.warn(`Channel "${channelName}" not found for role "${role}", falling back to main`);
      return this.mainProvider;
    }

    // 包装降级：运行时失败自动回退到 main
    if (channelName === 'main') return provider;

    const mainP = this.mainProvider;
    if (!mainP) return provider;

    return this.wrapWithFallback(provider, channelName, mainP);
  }

  /**
   * 直接通过通道名获取 Provider（不经过角色映射）。
   */
  getChannelProvider(name: string): Provider | null {
    return this.channelProviders.get(name) ?? null;
  }

  /**
   * 获取主通道 Provider。
   */
  getMainProvider(): Provider | null {
    return this.mainProvider;
  }

  /** 当前主通道 provider 类型（无主通道时返回 'unknown'） */
  getProviderType(): string {
    return this.mainProvider?.getProviderType() ?? 'unknown';
  }

  /** 当前主通道模型名（无主通道时返回空串） */
  getModel(): string {
    return this.mainProvider?.getModel() ?? '';
  }

  /** 列出所有通道名 */
  listChannelNames(): string[] {
    return Object.keys(this.config.channels);
  }

  /** 列出所有通道配置 */
  listChannels(): Array<ChannelConfig & { name: string }> {
    return Object.entries(this.config.channels).map(([name, cfg]) => ({
      name,
      ...cfg,
    }));
  }

  /** 列出所有角色映射 */
  listRoles(): Record<string, string> {
    return { ...this.config.roles };
  }

  // ── Mutate ───────────────────────────────────────────────────────

  /** 添加或更新通道。provider 可选，不填则继承 main 通道的 provider。 */
  upsertChannel(name: string, config: ChannelConfig): void {
    // provider 未指定时继承 main 通道的 provider
    if (!config.provider && name !== 'main') {
      const mainCfg = this.config.channels['main'];
      config = { ...config, provider: mainCfg?.provider ?? 'deepseek' };
    }
    this.config.channels[name] = config;
    // 立即创建 Provider 实例
    const provider = this.createChannelProvider(name);
    if (provider) {
      this.channelProviders.set(name, provider);
    }
    this.save();
    logger.info(`Channel upserted: ${name}`);
  }

  /** 删除通道（main 不可删除） */
  removeChannel(name: string): void {
    if (name === 'main') throw new Error('Cannot remove the "main" channel.');
    delete this.config.channels[name];
    this.channelProviders.delete(name);
    // 更新 roles 中引用此通道的条目回退到 main
    for (const [role, ch] of Object.entries(this.config.roles)) {
      if (ch === name) this.config.roles[role] = 'main';
    }
    this.save();
    logger.info(`Channel removed: ${name}`);
  }

  /** 设置角色→通道映射 */
  setRoleMapping(role: string, channelName: string): void {
    if (!this.config.channels[channelName]) {
      throw new Error(`Channel "${channelName}" does not exist.`);
    }
    this.config.roles[role] = channelName;
    this.save();
  }

  /** 设置主 Provider（切换主模型时调用） */
  setMainProvider(provider: Provider, providerType?: string): void {
    this.mainProvider = provider;
    this.channelProviders.set('main', provider);
    if (providerType) {
      this.config.channels['main'] = {
        ...this.config.channels['main'],
        provider: providerType,
      };
    }
  }

  /** 直接设置某个通道的 Provider 实例（绕过自动创建逻辑，用于注入带特定 userId 的 Provider） */
  setChannelProvider(name: string, provider: Provider): void {
    this.channelProviders.set(name, provider);
  }

  /**
   * 运行时切换通道模型（仅内存，不持久化到磁盘）。
   * 重启/新建 session 后恢复为 model-channels.json 中的持久化配置。
   *
   * @param name 通道名
   * @param provider Provider 类型
   * @param model 模型名（可选，不填则用 provider 默认）
   */
  setChannelModel(name: string, provider: string, model?: string): void {
    const existing = this.config.channels[name];
    const merged = { ...existing, provider, ...(model ? { model } : {}) };
    const instance = this.createChannelProviderFromConfig(name, merged);
    if (!instance) {
      throw new Error(`Cannot create provider for channel "${name}" with provider="${provider}"`);
    }
    // 非 main 通道：包装 ResilientProvider（重试 + 熔断）
    const wrapped = name !== 'main' ? new ResilientProvider(instance) : instance;
    this.channelProviders.set(name, wrapped);
    if (name === 'main') {
      this.mainProvider = wrapped;
    }
  }

  /**
   * 重置通道为持久化配置（取消 setChannelModel 的运行时覆盖）。
   */
  resetChannelModel(name: string): void {
    const cfg = this.config.channels[name];
    if (!cfg) throw new Error(`Channel "${name}" not found in config`);
    const instance = this.createChannelProvider(name);
    if (instance) {
      this.channelProviders.set(name, instance);
      if (name === 'main') {
        this.mainProvider = instance;
      }
    }
  }

  /**
   * 获取单个通道的详细信息。
   */
  getChannelInfo(name: string): {
    name: string;
    provider: string;
    model: string;
    description?: string;
    roles: string[];
    isMain: boolean;
    providerType: string;
  } | null {
    const provider = this.channelProviders.get(name);
    if (!provider) return null;
    const cfg = this.config.channels[name];
    if (!cfg) return null;
    const roles = Object.entries(this.config.roles)
      .filter(([, ch]) => ch === name)
      .map(([r]) => r);
    return {
      name,
      provider: provider.getProviderType(),
      model: provider.getModel(),
      description: cfg.description,
      roles,
      isMain: name === 'main',
      providerType: provider.getProviderType(),
    };
  }

  /** 从自定义配置创建 Provider 实例（共用创建逻辑） */
  private createChannelProviderFromConfig(name: string, cfg: ChannelConfig): Provider | null {
    if (!cfg.provider) {
      logger.warn(`Cannot create provider for channel "${name}": no provider specified`);
      return null;
    }
    try {
      const providerLoader = getProviderConfigLoader();
      const meta = providerLoader.getProvider(cfg.provider);

      const apiKey = cfg.apiKey
        ?? process.env[cfg.apiKeyEnv ?? meta?.envKey ?? '']
        ?? '';

      const providerConfig: ProviderConfig = {
        type: cfg.provider as ProviderType,
        apiKey,
        model: cfg.model ?? meta?.defaultModel ?? 'unknown',
        baseUrl: cfg.baseUrl ?? meta?.baseUrl,
        userId: cfg.userId,
      };

      const provider = ProviderManager.createProviderFromConfig(providerConfig);
      if (cfg.thinking === false) provider.setThinking?.(false);
      logger.info(`Channel provider created: ${name} (${cfg.provider}/${provider.getModel()})`);
      return provider;
    } catch (err) {
      logger.warn(`Failed to create provider for channel "${name}": ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 按角色现建一个带独立 userId 的短命 Provider 实例（不写入通道实例表）。
   *
   * 用途：独立于主 loop 的 LLM 调用方（压缩器/子 Agent/旁路等）按调用现场
   * 取 provider，实现 DeepSeek user_id 的 session/实例级 KVCache 隔离。
   *
   * 与 getProvider 的区别：getProvider 返回通道内的**长驻共享实例**
   * （userId 固定为通道默认）；本方法每次现建新实例（通道配置相同、
   * userId 按调用者提供），调用方自行持有，用后即弃。
   *
   * 解析顺序：role → 通道（roles 映射，无映射用同名通道）→ 通道配置
   * （无则用 main 配置）。key/model/baseUrl 解析与降级链同常规通道。
   * 返回 null：通道配置不存在或实例创建失败（无 key 等）——调用方决定降级。
   */
  createScopedProvider(role: string, userId: string): Provider | null {
    const channelName = this.config.roles[role] ?? role;
    const cfg = this.config.channels[channelName] ?? this.config.channels['main'];
    if (!cfg) {
      logger.warn(`createScopedProvider: no channel config for role "${role}"`);
      return null;
    }
    const instance = this.createChannelProviderFromConfig(`scoped:${role}`, { ...cfg, userId });
    if (!instance) return null;
    // 与常规通道一致：非 main 通道包弹性层（重试+熔断）
    return channelName === 'main' ? instance : new ResilientProvider(instance);
  }

  // ── Internal ─────────────────────────────────────────────────────

  /** 读取配置文件（先项目级，再全局） */
  private readConfigFile(): ModelChannelsConfig | null {
    for (const p of [this.configPath, this.globalConfigPath]) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw) as ModelChannelsConfig;
        if (parsed.channels && typeof parsed.channels === 'object') {
          logger.info('Read model channels config', { path: p });
          return parsed;
        }
      } catch {
        // 文件不存在或无效，继续尝试下一个
      }
    }
    return null;
  }

  /** 合并硬编码默认值：用户配置的 roles 覆盖默认 roles */
  private mergeDefaults(loaded: ModelChannelsConfig): ModelChannelsConfig {
    const roles = { ...DEFAULT_ROLES, ...loaded.roles };
    // 确保 main 通道始终存在
    if (!loaded.channels['main']) {
      const providerLoader = getProviderConfigLoader();
      const activeMeta = providerLoader.getProvider(this.legacyProviderActive ?? 'deepseek');
      loaded.channels['main'] = {
        provider: this.legacyProviderActive ?? 'deepseek',
        model: activeMeta?.defaultModel,
        description: '主对话通道',
      };
    }
    return { channels: loaded.channels, roles };
  }

  /** 初始化所有通道的 Provider 实例 */
  initializeChannels(): void {
    this.channelProviders.clear();
    for (const name of Object.keys(this.config.channels)) {
      const provider = this.createChannelProvider(name);
      if (provider) {
        this.channelProviders.set(name, provider);
        if (name === 'main') {
          // mainProvider 可能已被外部设置，仅当未设置时使用创建的
          if (!this.mainProvider) this.mainProvider = provider;
        }
      }
    }
  }

  /** 根据通道名创建 Provider 实例（非 main 通道自动包装 ResilientProvider） */
  private createChannelProvider(name: string): Provider | null {
    const cfg = this.config.channels[name];
    if (!cfg) return null;

    // main 通道：如果已有外部传入的 mainProvider（已含完整弹性层），直接使用
    if (name === 'main' && this.mainProvider) {
      return this.mainProvider;
    }

    try {
      const raw = this.createChannelProviderFromConfig(name, cfg);
      if (!raw) return null;

      // 非 main 通道：包装 ResilientProvider（重试 + 熔断）
      if (name !== 'main') {
        const resilient = new ResilientProvider(raw);
        logger.info(`Channel provider created (with resilience): ${name} (${cfg.provider}/${raw.getModel()})`);
        return resilient;
      }

      logger.info(`Channel provider created: ${name} (${cfg.provider}/${raw.getModel()})`);
      return raw;
    } catch (err) {
      logger.warn(`Failed to create provider for channel "${name}": ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 包装非 main 通道 Provider：运行时失败自动降级到 main Provider。
   * 不包装 main 通道自身。
   */
  private wrapWithFallback(
    channelProvider: Provider,
    channelName: string,
    mainP: Provider,
  ): Provider {
    const self = this;
    return {
      async *createStream(
        messages: Message[],
        tools?: ToolDefinition[],
        signal?: AbortSignal,
      ): AsyncIterable<StreamEvent> {
        try {
          for await (const event of channelProvider.createStream(messages, tools, signal)) {
            yield event;
          }
        } catch (error) {
          logger.warn(
            `Channel "${channelName}" failed, falling back to main. ${(error as Error).message}`,
          );
          for await (const event of mainP.createStream(messages, tools, signal)) {
            yield event;
          }
        }
      },

      getProviderType() {
        return channelProvider.getProviderType();
      },

      getModel() {
        return channelProvider.getModel();
      },

      getCapabilities() {
        return channelProvider.getCapabilities?.() ?? {
          toolCalling: false, streaming: true, adapterSupport: false,
          maxContextTokens: 4096, isLocal: false, vision: false,
        };
      },

      setThinking(enabled: boolean, effort?: string | number) {
        channelProvider.setThinking?.(enabled, effort);
      },
    };
  }

  // ── Persist ──────────────────────────────────────────────────────

  private save(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 不保存由 legacy 自动构建的标记
      const toSave: ModelChannelsConfig = {
        channels: this.config.channels,
        roles: this.config.roles,
      };
      fs.writeFileSync(this.configPath, JSON.stringify(toSave, null, 2), 'utf-8');
    } catch (err) {
      logger.warn(`Failed to save model channels config: ${(err as Error).message}`);
    }
  }
}
