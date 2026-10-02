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
import type { ProviderFields, ProviderSampling } from './fields.js';
import { derivedUserId } from './user-id.js';

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
  /**
     * 思考配置（2026-10-01 起归通道所有 —— 思考是「模型怎么被调用」的参数）。
     *   - false / 'off'             → 关闭
     *   - true  / 'on' / 未配置      → 开启（用 provider 默认强度）
     *   - 'high' | 'max'            → DeepSeek 系 reasoning effort
     *   - '4k' | '8k' | '16k' | '32k' → Anthropic 系 thinking 预算（token）
     * 档位天然属于通道：通道决定模型，档位的可用集合也就由该模型所属厂商决定。
     */
  thinking?: boolean | string;
  /**
   * 采样参数（temperature / topP / penalties）。
   * 新增：此前通道配置**根本没有这一项**，且装配时也没往下传 ⇒ 通道级采样静默失效。
   */
  sampling?: ProviderSampling;
  /** 单次请求最大输出 token 数（覆盖模型目录默认） */
  maxOutputTokens?: number;
  /** 通用字段（userId 归一入口；与 userId 同时存在时以 fields 为准） */
  fields?: ProviderFields;
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
/**
 * 默认通道名（**原为 `main`**，2026-10-01 用户定调改名）。
 *
 * 为什么必须改：`main` 在本仓库里有**两个互不相干的含义** ——
 *   ① 本文件里的一条**通道**；② `ProviderRouter` 里的一个**注册项**（主对话老机制用）。
 * 两者同名却是两个独立对象，是"切通道对主对话无效"这类困惑的根源。
 * 改名为 `default` 后语义明确：它是**默认通道**（未绑定调用点时的兜底），不是"主对话通道"。
 *
 * ⚠️ 读取旧配置时走 {@link migrateLegacyChannelNames}，不要直接删旧键。
 */
const DEFAULT_CHANNEL = 'default';

/**
 * 主对话专属通道名（2026-10-01 用户定调：主对话有**自己的**通道，不复用其它通道）。
 * 与调用点名同名（role `chat`），语义直白。
 */
const CHAT_CHANNEL = 'chat';

/** 旧配置里的通道名 → 新名（兼容读取用，勿删） */
const LEGACY_CHANNEL_ALIASES: Record<string, string> = {
  main: DEFAULT_CHANNEL,
};

const DEFAULT_ROLES: Record<string, string> = {
  assessment: DEFAULT_CHANNEL,
  planning: DEFAULT_CHANNEL,
  compression: DEFAULT_CHANNEL,
  'sub-agent': DEFAULT_CHANNEL,
  // 主对话也是一个调用点（2026-10-01 统一，见 docs/design/model-channel-unification.md）。
  // 此前主对话不走通道（走 loop.provider），导致"切通道对主对话无效"。
  // 指向**专属通道** chat —— 该通道在 mergeDefaults 中自动补建（配置同 default）。
  chat: CHAT_CHANNEL,
};

/** 全局配置文件路径（~/.agent/model-channels.json；项目级已取消，P-Config 收敛）
 *
 * ⚠️ 2026-09-19 加测试隔离覆盖点 —— 起因是一次实测事故：
 *   `src/provider/model-scoped-provider.test.ts` 会 `new ModelChannelRegistry()` 并
 *   upsertChannel 写入夹具值（`main-model` / `test-model` / `test-key`）。而构造函数
 *   **没有路径参数**（cwd 已被有意废弃），于是它写的是**用户真实的**这个文件。
 *   后果链：每次全量测试把真实通道配置覆盖成夹具值 → channel-watcher 热重载 →
 *   压缩通道拿字面量 "test-key" 调 DeepSeek → 401 → `summary_failed` →
 *   压缩**静默降级**为机械裁剪（≈1%，而非走 LLM 摘要的 ≈30%），且只打 warn。
 *   实测证据：单跑该测试文件前后，真实文件 SHA256 由 9275D356… 变为 25823976…。
 *   做法与 `memory/session.ts` 的 HYACINTH_SESSIONS_ROOT 同款：**生产行为不变**，
 *   仅当显式设置该环境变量时才改路径。
 */
function getGlobalConfigPath(): string {
  const override = process.env.HYACINTH_MODEL_CHANNELS_PATH;
  if (override) return override;
  return path.join(os.homedir(), '.agent', 'model-channels.json');
}

// ── Registry ───────────────────────────────────────────────────────

/**
 * 把通道的 thinking 配置翻译成 provider 的 (enabled, effort?)，并施加。
 *
 * 为什么放在通道层：思考是「这个模型怎么被调用」的参数，不是会话/界面的偏好。
 * 档位集合由**该通道的厂商**决定（DeepSeek 系认 strength 名，Anthropic 系认 token 预算），
 * 但翻译时不做厂商校验 —— 传错档位由 provider 自己忽略（多传的参数无害），
 * 这样切换通道厂商时已设的档位不会突然变成错误。
 *
 * 未配置 ⇒ 不动（保留 provider 默认）；无法识别的值 ⇒ 按「开」处理并告警，
 * 宁可开着也不静默关掉思考。
 */
export function applyChannelThinking(
  provider: { setThinking?: (enabled: boolean, effort?: string | number) => void },
  thinking: boolean | string | undefined,
): void {
  if (thinking === undefined || thinking === null) return;
  if (thinking === false || thinking === 'off') { provider.setThinking?.(false); return; }
  if (thinking === true || thinking === 'on') { provider.setThinking?.(true); return; }
  const budgets: Record<string, number> = { '4k': 4000, '8k': 8000, '16k': 16000, '32k': 32000 };
  if (Object.prototype.hasOwnProperty.call(budgets, thinking)) {
    provider.setThinking?.(true, budgets[thinking]);
    return;
  }
  if (thinking === 'high' || thinking === 'max') {
    provider.setThinking?.(true, thinking);
    return;
  }
  logger.warn(`Unknown channel thinking value "${thinking}" — treating as enabled`);
  provider.setThinking?.(true);
}

export class ModelChannelRegistry {
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
  /**
   * 运行时发现的调用点（role → 实际生效的通道名）。
   *
   * 只记录**没有显式映射**的 role：它们此前取 provider 时静默走兜底
   * （default 通道，或 scoped 版的同名通道），而列表只列配置里写过的映射
   * ⇒ 插件带来的新调用点「挂得上、但看不见」。
   * 这里让第一次来取连接的调用点自动现身，界面才能列全、并显示它实际吃哪条通道。
   *
   * **只进内存、不落盘** —— 自动发现不是用户意图，不该污染配置文件
   *（语义与 `setChannelModel` 相反：后者是用户显式改，默认落盘 ✓）；
   * 重启后重新发现即可，因此不会污染 model-channels.json。
   */
  private runtimeRoles: Map<string, string> = new Map();

  constructor(cwd?: string) {
    // P-Config 收敛：项目级配置已取消，统一只读全局 ~/.agent/model-channels.json。
    // 构造参数 cwd 保留仅为调用方兼容，不再用于定位任何项目级文件。
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
    this.config.channels[DEFAULT_CHANNEL] = {
      provider: activeType,
      model: activeMeta?.defaultModel,
      description: '主对话通道（自动构建）',
    };

    // roles：从 legacy modelsConfig 推断
    // source='local' 的角色 → 创建以角色命名的通道（如 compression → compression 通道用 local provider）
    // source=DEFAULT_CHANNEL 的角色 → 直接映射到 main
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
          this.config.roles[role] = DEFAULT_CHANNEL;
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
    const channelName = this.config.roles[role] ?? DEFAULT_CHANNEL;
    this.noteDiscoveredRole(role, channelName);
    const provider = this.channelProviders.get(channelName);

    if (!provider) {
      logger.warn(`Channel "${channelName}" not found for role "${role}", falling back to main`);
      return this.mainProvider;
    }

    // 包装降级：运行时失败自动回退到 main
    if (channelName === DEFAULT_CHANNEL) return provider;

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

  /**
   * 列出所有角色映射 —— 含**运行时自动发现**的调用点（显式配置优先）。
   *
   * 这样界面能自然列全：插件新带来的调用点，只要取过一次连接就会出现在这里。
   */
  listRoles(): Record<string, string> {
    return { ...Object.fromEntries(this.runtimeRoles), ...this.config.roles };
  }

  /**
   * 仅「运行时发现」的调用点（显式映射不在其中）。
   * 供界面区分显示：哪些是用户配的，哪些是自动冒出来的。
   */
  listDiscoveredRoles(): Record<string, string> {
    return Object.fromEntries(this.runtimeRoles);
  }

  /**
   * 记下一个没有显式映射的调用点（内存态，不落盘）。
   * 重复取用会刷新它实际走的通道，所以配置热更后显示不会陈旧。
   */
  private noteDiscoveredRole(role: string, effectiveChannel: string): void {
    if (typeof role !== 'string' || role.length === 0) return;
    if (this.config.roles[role]) return; // 显式映射本就可见，不必记
    this.runtimeRoles.set(role, effectiveChannel);
  }

  // ── Mutate ───────────────────────────────────────────────────────

  /** 添加或更新通道。**浅合并**既有配置 —— 未指定的字段一律保留。 */
  upsertChannel(name: string, config: ChannelConfig): void {
    // ⚠️ 2026-10-02 修：此前是**整体替换**（`channels[name] = config`）⇒ 只改一个字段
    // 会把其余字段一起抹掉。实测后果：TUI 里改 thinking 开关（只传 { thinking }）
    // 把 chat 通道的 model 冲没了 —— 配置文件里至今留着 `chat: { provider, thinking }`
    // 这条无 model 的残迹。改为浅合并；显式传 undefined 视为"未指定"，不参与覆盖。
    const existing = this.config.channels[name] ?? {};
    const patch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    ) as ChannelConfig;
    const merged: ChannelConfig = { ...existing, ...patch };
    // provider 未指定时继承 main 通道的 provider
    if (!merged.provider && name !== DEFAULT_CHANNEL) {
      const mainCfg = this.config.channels[DEFAULT_CHANNEL];
      merged.provider = mainCfg?.provider ?? 'deepseek';
    }
    this.config.channels[name] = merged;
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
    if (name === DEFAULT_CHANNEL) throw new Error('Cannot remove the "main" channel.');
    delete this.config.channels[name];
    this.channelProviders.delete(name);
    // 更新 roles 中引用此通道的条目回退到 main
    for (const [role, ch] of Object.entries(this.config.roles)) {
      if (ch === name) this.config.roles[role] = DEFAULT_CHANNEL;
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
    this.channelProviders.set(DEFAULT_CHANNEL, provider);
    if (providerType) {
      this.config.channels[DEFAULT_CHANNEL] = {
        ...this.config.channels[DEFAULT_CHANNEL],
        provider: providerType,
      };
    }
  }

  /** 直接设置某个通道的 Provider 实例（绕过自动创建逻辑，用于注入带特定 userId 的 Provider） */
  setChannelProvider(name: string, provider: Provider): void {
    this.channelProviders.set(name, provider);
  }

  /**
   * 切换通道的提供商/模型，**默认写入配置文件并持久化**。
   *
   * ⚠️ 2026-10-02 语义反转（旧行为＝仅内存、不落盘）：旧实现有三个恶果 ——
   *   ① 切换重启即丢（"切了记不住"，用户实际踩到）；
   *   ② 配置副本与实例分叉 ⇒ `listChannels()` 显示旧值、`list_providers` 显示新值，
   *      两个工具对同一次切换给出矛盾答案，是主要困惑源；
   *   ③ 跨 UI/进程互不可见（每个进程各持一份内存副本，谁也没写盘 ⇒ 谁也不知道）。
   * 现在默认 persist：写回 `config.channels[name]` + `save()`，文件变化再由
   * channel-watcher 广播给其它 registry 实例（装配期实例与协议层实例因此收敛）。
   * 需要"纯临时试验"时显式传 `{ persist: false }` —— 此时仍是旧语义，
   * 不写回 config，`resetChannelModel()` 可恢复持久化值。
   *
   * @param name 通道名
   * @param provider Provider 类型
   * @param model 模型名（可选，不填则用 provider 默认）
   * @param opts.persist 是否落盘（默认 true）
   */
  setChannelModel(
    name: string,
    provider: string,
    model?: string,
    opts?: { persist?: boolean },
  ): void {
    const persist = opts?.persist !== false;
    const existing = this.config.channels[name];
    const merged = { ...existing, provider, ...(model ? { model } : {}) };
    const instance = this.createChannelProviderFromConfig(name, merged);
    if (!instance) {
      throw new Error(`Cannot create provider for channel "${name}" with provider="${provider}"`);
    }
    // 非 main 通道：包装 ResilientProvider（重试 + 熔断）
    const wrapped = name !== DEFAULT_CHANNEL ? new ResilientProvider(instance) : instance;
    this.channelProviders.set(name, wrapped);
    if (name === DEFAULT_CHANNEL) {
      this.mainProvider = wrapped;
    }
    if (persist) {
      // 写回配置副本（消除"配置视角 vs 实例视角"分叉）后再落盘
      this.config.channels[name] = merged;
      this.save();
      logger.info(
        `Channel model persisted: ${name} (${provider}/${model ?? merged.model ?? '(provider default)'})`,
      );
    }
  }

  /**
   * 从持久化配置重建通道实例。
   *
   * 用途已收窄：只对 `setChannelModel(..., { persist: false })` 留下的**临时覆盖**
   * 有意义（那类覆盖不写回 config，故重建即可回到持久化值）。
   * 默认落盘的切换会同步改 config ⇒ 此处重建结果与当前值一致，等价于空操作。
   */
  resetChannelModel(name: string): void {
    const cfg = this.config.channels[name];
    if (!cfg) throw new Error(`Channel "${name}" not found in config`);
    const instance = this.createChannelProvider(name);
    if (instance) {
      this.channelProviders.set(name, instance);
      if (name === DEFAULT_CHANNEL) {
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
      isMain: name === DEFAULT_CHANNEL,
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
        // 未显式配置 userId ⇒ 按**名字派生**一个独立池（2026-10-02）。
        // 此前留空的下场：翻译层兜底成 DEFAULT_USER_ID ⇒ 所有"没配 id"的通道共用同一个池，
        // 互相挤占 KVCache（症状：聊到一半突然变慢变贵，归因极难）。
        // 派生只用于创建实例，**不写回配置**（不污染 model-channels.json）。
        userId: cfg.userId || derivedUserId(name),
        // 透传通道级采样 / 输出上限 / 通用字段。
        // 此前只传 key/model/baseUrl/userId ⇒ 通道配置里的采样参数静默失效
        //（且 ChannelConfig 本身也没有这些字段，两层同时缺）。
        ...(cfg.maxOutputTokens !== undefined ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
        ...(cfg.fields ? { fields: cfg.fields } : {}),
        ...(cfg.sampling ? { sampling: cfg.sampling } : {}),
      };

      const provider = ProviderManager.createProviderFromConfig(providerConfig);
      applyChannelThinking(provider, cfg.thinking);
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
    const cfg = this.config.channels[channelName] ?? this.config.channels[DEFAULT_CHANNEL];
    if (!cfg) {
      logger.warn(`createScopedProvider: no channel config for role "${role}"`);
      return null;
    }
    // 登记「实际生效」的通道：同名通道不存在时会落到 default
    this.noteDiscoveredRole(role, this.config.channels[channelName] ? channelName : DEFAULT_CHANNEL);
    // 生效 userId 三级（2026-10-02）：**传入值 > 通道配置 > 按 role 派生**。
    // 旧实现是 `{ ...cfg, userId }` —— 传空即**抹掉**通道里配好的 id，直接掉进
    // DEFAULT_USER_ID 全局池（静默共池，最难归因）。现在任何一级都不会退到全局池。
    const effectiveUserId =
      userId && userId.trim() ? userId : cfg.userId || derivedUserId(role);
    const instance = this.createChannelProviderFromConfig(`scoped:${role}`, { ...cfg, userId: effectiveUserId });
    if (!instance) return null;
    // 与常规通道一致：非 main 通道包弹性层（重试+熔断）
    return channelName === DEFAULT_CHANNEL ? instance : new ResilientProvider(instance);
  }

  // ── Internal ─────────────────────────────────────────────────────

  /** 读取配置文件（先项目级，再全局） */
  private readConfigFile(): ModelChannelsConfig | null {
    try {
      const raw = fs.readFileSync(this.globalConfigPath, 'utf-8');
      const parsed = JSON.parse(raw) as ModelChannelsConfig;
      if (parsed.channels && typeof parsed.channels === 'object') {
        logger.info('Read model channels config', { path: this.globalConfigPath });
        return parsed;
      }
    } catch {
      // 文件不存在或无效 → 返回 null（走 legacy 构建）
    }
    return null;
  }

  /**
   * 合并硬编码默认值：用户配置的 roles 覆盖默认 roles。
   *
   * 同时承担两件事（2026-10-01 通道统一，见 docs/design/model-channel-unification.md）：
   *  ① **旧通道名迁移**：main → default（含 roles 里指向它的值）。原地改名，不留两份。
   *  ② **补建主对话专属通道** chat：配置继承 default，使 role chat 有落点。
   *     —— 至此「主对话也是一个调用点」在数据层完全成立。
   */
  private mergeDefaults(loaded: ModelChannelsConfig): ModelChannelsConfig {
    // ① 旧名迁移（channels 与 roles 都要迁，否则会留下指向不存在通道的悬空映射）
    const channels: Record<string, ChannelConfig> = {};
    let migrated = 0;
    for (const [name, cfg] of Object.entries(loaded.channels ?? {})) {
      const target = LEGACY_CHANNEL_ALIASES[name] ?? name;
      if (target !== name) migrated++;
      channels[target] = cfg;
    }
    const roles: Record<string, string> = {};
    for (const [role, ch] of Object.entries(loaded.roles ?? {})) {
      const target = LEGACY_CHANNEL_ALIASES[ch] ?? ch;
      if (target !== ch) migrated++;
      roles[role] = target;
    }
    if (migrated > 0) {
      logger.info('Model channels: migrated legacy names', { count: migrated });
    }

    const mergedRoles = { ...DEFAULT_ROLES, ...roles };

    // 确保默认通道存在
    if (!channels[DEFAULT_CHANNEL]) {
      const providerLoader = getProviderConfigLoader();
      const activeName = this.legacyProviderActive ?? 'deepseek';
      const activeMeta = providerLoader.getProvider(activeName);
      channels[DEFAULT_CHANNEL] = {
        provider: activeName,
        model: activeMeta?.defaultModel,
        description: '默认通道（未绑定调用点时的兜底）',
      };
    }

    // 补建主对话专属通道：无则继承默认通道配置
    if (!channels[CHAT_CHANNEL]) {
      channels[CHAT_CHANNEL] = {
        ...channels[DEFAULT_CHANNEL],
        description: '主对话专属通道',
      };
    }

    return { channels, roles: mergedRoles };
  }

  /** 初始化所有通道的 Provider 实例 */
  initializeChannels(): void {
    this.channelProviders.clear();
    for (const name of Object.keys(this.config.channels)) {
      const provider = this.createChannelProvider(name);
      if (provider) {
        this.channelProviders.set(name, provider);
        if (name === DEFAULT_CHANNEL) {
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
    if (name === DEFAULT_CHANNEL && this.mainProvider) {
      return this.mainProvider;
    }

    try {
      const raw = this.createChannelProviderFromConfig(name, cfg);
      if (!raw) return null;

      // 非 main 通道：包装 ResilientProvider（重试 + 熔断）
      if (name !== DEFAULT_CHANNEL) {
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
      const dir = path.dirname(this.globalConfigPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 不保存由 legacy 自动构建的标记
      const toSave: ModelChannelsConfig = {
        channels: this.config.channels,
        roles: this.config.roles,
      };
      fs.writeFileSync(this.globalConfigPath, JSON.stringify(toSave, null, 2), 'utf-8');
    } catch (err) {
      logger.warn(`Failed to save model channels config: ${(err as Error).message}`);
    }
  }
}
