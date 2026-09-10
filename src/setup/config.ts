/**
 * ## 配置管理 — 外部化原则
 *
 * 项目设计原则：所有可配置值必须通过配置体系读取，不得在代码中写死默认值。
 *
 * 配置层级：
 *   内置默认值（src/runtime/defaults.ts）
 *   → 用户项目配置（.agent/config.json）
 *   → RuntimeConfigCenter（运行时读写，即时生效）
 *
 * 新增配置项：
 *   1. 在 AgentConfig 接口中定义字段
 *   2. 在 getDefaultConfig() 中提供默认值
 *   3. 代码中通过 configCenter.get('path.to.key') 读取
 *   4. 不要在模块内部硬编码 fallback 值——交给配置体系
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getLocalProviderConfigLoader } from '../provider/local-config.js';
import { DEFAULT_PROVIDERS } from '../provider/config.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import { registerSecretKeys } from '../kernel/security/index.js';

/** 安全配置 */
export interface SafetyConfig {
  /** 需要安全审查的危险工具列表 */
  dangerousTools: string[];
  /** 白名单工具（危险列表中的工具，但已获得永久授权） */
  allowedTools: string[];
  /** 白名单命令模式（仅对 bash 工具生效，支持 glob 匹配如 "git *""npm test"） */
  allowedCommands: string[];
  /** 绝对禁止执行的工具名（插件层强制，独立于内置权限；permission-chain 插件消费） */
  denyTools?: string[];
}

/** 上下文管理配置 */
export interface ContextConfig {
  /** 压缩触发阈值 (0~1) */
  compressThreshold: number;
  /** 紧急同步压缩阈值 (0~1) */
  emergencyThreshold: number;
  /** 压缩激进程度 (0~1) */
  compressDepth: number;
}

/** 调度器配置 */
export interface ScheduleConfig {
  /** 心跳间隔 (毫秒) */
  heartbeatMs: number;
  /** 最大并发任务数 */
  maxConcurrent: number;
  /** 任务超时时间 (毫秒) */
  taskTimeoutMs: number;
  /** 最大记录数 */
  maxRecords: number;
}

/** 单个 Agent 的覆写配置 */
export interface AgentOverrideConfig {
  /** 最大对话轮次 */
  maxTurns?: number;
  /** 允许使用的工具列表 */
  allowedTools?: string[];
  /** 会话 TTL（分钟），超时未调用则自动清理 */
  sessionTtlMinutes?: number;
}

/** Agent 集合配置 (按 Agent 名称覆写默认行为) */
export interface AgentsConfig {
  [agentName: string]: AgentOverrideConfig | undefined;
}

/** 模型路由源配置 */
export interface ModelSourceConfig {
  source: 'main' | 'local';
  model?: string;
}

/** 模型路由配置 */
export interface ModelsConfig {
  assessment: ModelSourceConfig;
  planning: ModelSourceConfig;
  compression: ModelSourceConfig;
}

/** 本地模型全局配置 */
export interface LocalModelConfig {
  baseUrl?: string;
  defaultModel?: string;
}

/** 飞书渠道配置 */
export interface FeishuChannelConfigEntry {
  enabled?: boolean;
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  allowFrom?: string[];
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom?: string[];
  requireMention?: boolean;
  resolveSenderNames?: boolean;
  /** 飞书消息是否同步到 TUI 界面（默认 false） */
  tuiSync?: boolean;
  /** session 复用策略（默认 'per_user'） */
  sessionMode?: 'shared' | 'per_chat' | 'per_user';
}

/** ClawBot 渠道配置 */
export interface ClawbotChannelConfigEntry {
  enabled?: boolean;
  /** bot_token（留空则首次自动走扫码授权流程，7 天有效） */
  botToken?: string;
  /** bot 用户 ID（授权后自动填充，格式 xxx@im.bot） */
  botId?: string;
  /** 用户 ID（授权后自动填充，格式 xxx@im.wechat） */
  userId?: string;
  /** iLink API 根域名（默认 https://ilinkai.weixin.qq.com） */
  baseUrl?: string;
  /** 是否同步到 TUI 界面（默认 false） */
  tuiSync?: boolean;
  /** 发送文本消息的最大长度（默认 2000） */
  textChunkLimit?: number;
  /** 是否自动刷新 token（默认 true） */
  autoRefreshToken?: boolean;
  /** HTTP 请求超时（毫秒，默认 30000） */
  httpTimeoutMs?: number;
  /** 长轮询等待时长（秒，默认 28） */
  pollTimeoutSec?: number;
  /** 轮询失败重试间隔（毫秒，默认 3000） */
  pollRetryIntervalMs?: number;
}

/** 渠道配置集合 */
export interface ChannelsConfig {
  feishu?: FeishuChannelConfigEntry;
  clawbot?: ClawbotChannelConfigEntry;
}

/** Agent 配置（非敏感） */
export interface AgentConfig {
  provider: string;
  model: string;
  maxTurns: number;
  maxContext: number;
  /** Provider retry configuration */
  retry?: Partial<{
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }>;
  /** Provider circuit breaker configuration */
  circuitBreaker?: Partial<{
    failureThreshold: number;
    cooldownMs: number;
  }>;
  /** Fallback provider types (tried in order after primary fails) */
  fallbackProviders?: string[];
  /** Persona 模板文件目录 */
  personaDir?: string;
  /** 安全配置 */
  safety?: SafetyConfig;
  /** 上下文管理配置 */
  context?: ContextConfig;
  /** 调度器配置 */
  schedule?: ScheduleConfig;
  /** Agent 集合覆写配置 */
  agents?: AgentsConfig;
  /** 模型路由配置 */
  models?: ModelsConfig;
  /** 本地模型全局配置 */
  local?: LocalModelConfig;
  /** 渠道配置 */
  channels?: ChannelsConfig;
  /** 跨会话记忆文件路径（默认 ~/.agent/prompts/persona/memory.md） */
  memoryFile?: string;
  /** 旁路 Agent 配置（默认开关，运行时可用 /orchestrator 切换） */
  bypass?: {
    /** Orchestrator 是否默认启用（每轮增加少量延迟） */
    orchestratorEnabled?: boolean;
  };
  /** 知识库配置（默认开关，运行时可用 /kb 切换） */
  kb?: {
    /** 是否默认启用 */
    enabled?: boolean;
  };
  /**
   * UI 用户偏好（跨项目共享，save() 时始终写入全局配置，不随项目级配置走）。
   * 新增字段记得同步 src/runtime/config-schema.ts 的 FullConfig 与 defaults.ts。
   */
  ui?: {
    /** WebUI 主题：hyacinth(琥珀金深色,默认) / midnight(冷蓝) / forest(青绿) / rose(粉紫) / light(浅色) */
    theme?: 'hyacinth' | 'midnight' | 'forest' | 'rose' | 'light';
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  provider: 'anthropic',
  model: '',
  maxTurns: getDefaultConfig().session.maxTurns,
  maxContext: 200000,
  safety: {
    // 空数组 = 默认按工具 sideEffect 自动推导：'write'/'exec' 需审批，'read' 放行。
    // 显式给出名单 = 加性覆盖（在推导集之上追加）；要豁免某工具请用 allowedTools。
    dangerousTools: [],
    allowedTools: [],
    allowedCommands: [],
  },
  context: {
    compressThreshold: 0.75,
    emergencyThreshold: 0.92,
    compressDepth: 0.5,
  },
  schedule: {
    heartbeatMs: 5000,
    maxConcurrent: 10,
    taskTimeoutMs: 300000,
    maxRecords: 1000,
  },
  models: {
    assessment: { source: 'main' },
    planning: { source: 'main' },
    compression: { source: 'main' },
  },
  local: getLocalProviderConfigLoader(),
  channels: {
    feishu: {
      enabled: false,
      appId: '',
      appSecret: '',
      domain: 'feishu',
      dmPolicy: 'allowlist',
      groupPolicy: 'allowlist',
      requireMention: true,
      tuiSync: false,
      sessionMode: 'per_user',
    },
    clawbot: {
      enabled: false,
      botToken: '',
      botId: '',
      userId: '',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      tuiSync: false,
      textChunkLimit: 2000,
      autoRefreshToken: true,
      httpTimeoutMs: 30_000,
      pollTimeoutSec: 28,
      pollRetryIntervalMs: 3000,
    },
  },
  memoryFile: path.join(os.homedir(), '.agent', 'prompts', 'persona', 'memory.md'),
};

/** 默认最大上下文 Token 数 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200000;

/** Provider 到 API Key 环境变量名的映射（从 DEFAULT_PROVIDERS 派生，单一来源） */
export const API_KEY_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(DEFAULT_PROVIDERS.providers).map(([id, meta]) => [id, meta.envKey]),
);

export class ConfigManager {
  private configDir: string;
  private projectDir: string | undefined;
  /** 本进程从 .env 文件加载的键名集合（供安全内核注册，值不外传） */
  private loadedEnvKeyNames = new Set<string>();

  constructor(projectDir?: string) {
    this.configDir = path.join(os.homedir(), '.agent');
    this.projectDir = projectDir;
  }

  getConfigDir(): string { return this.configDir; }
  getSessionsDir(): string { return path.join(this.configDir, 'sessions'); }
  getConfigPath(): string { return path.join(this.configDir, 'config.json'); }
  getEnvPath(): string { return path.join(this.configDir, '.env'); }

  /** 获取项目级配置文件路径 */
  getProjectConfigPath(): string | null {
    if (!this.projectDir) return null;
    return path.join(this.projectDir, '.agent', 'config.json');
  }

  /** 获取项目级 .env 文件路径 */
  getProjectEnvPath(): string | null {
    if (!this.projectDir) return null;
    return path.join(this.projectDir, '.agent', '.env');
  }

  /** 是否首次运行 */
  async isFirstRun(): Promise<boolean> {
    try {
      await fs.access(this.getConfigPath());
      return false;
    } catch {
      return true;
    }
  }

  /** 确保配置目录存在 */
  async ensureDir(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.mkdir(this.getSessionsDir(), { recursive: true });
  }

  /**
   * 加载配置（合并层级：默认 → 全局 → 项目级）
   * 项目级配置覆盖全局配置
   */
  async load(): Promise<AgentConfig> {
    // 1. 加载全局配置
    let config = { ...DEFAULT_CONFIG };
    try {
      const content = await fs.readFile(this.getConfigPath(), 'utf-8');
      const parsed = JSON.parse(content);
      config = { ...config, ...parsed };
    } catch {
      // 全局配置不存在，使用默认值
    }

    // 2. 加载项目级配置（覆盖全局）
    const projectConfigPath = this.getProjectConfigPath();
    if (projectConfigPath) {
      try {
        const content = await fs.readFile(projectConfigPath, 'utf-8');
        const parsed = JSON.parse(content);
        config = { ...config, ...parsed };
      } catch {
        // 项目级配置不存在，忽略
      }
    }

    return config;
  }

  /**
   * 保存配置到合适的配置文件。
   * 如果存在项目级配置文件，写入项目级（因为 load() 时项目级覆盖全局）；
   * 否则写入全局配置文件。
   */
  async save(config: AgentConfig): Promise<void> {
    await this.ensureDir();
    // ui 是用户偏好（主题等），不随项目级配置走：剥离出来单独写全局
    const { ui, ...businessConfig } = config;
    if (ui !== undefined) {
      await this.saveUserSection({ ui } as Partial<AgentConfig>);
    }
    const projectConfigPath = this.getProjectConfigPath();
    if (projectConfigPath) {
      // 检查项目级配置文件是否存在
      try {
        await fs.access(projectConfigPath);
        // 项目级配置存在 → 写入项目级（不含 ui 用户偏好）
        const dir = path.dirname(projectConfigPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(projectConfigPath, JSON.stringify(businessConfig, null, 2), 'utf-8');
        return;
      } catch {
        // 项目级配置不存在，回退到全局
      }
    }
    await fs.writeFile(this.getConfigPath(), JSON.stringify(businessConfig, null, 2), 'utf-8');
  }

  /**
   * 合并写入全局配置的用户偏好节（如 ui.theme）。
   * 只覆盖传入的顶层键，不影响全局配置里的其他字段。
   */
  async saveUserSection(partial: Partial<AgentConfig>): Promise<void> {
    await this.ensureDir();
    const globalPath = this.getConfigPath();
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(await fs.readFile(globalPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // 全局配置不存在或损坏 → 从空对象开始
    }
    const merged = { ...current, ...(partial as Record<string, unknown>) };
    await fs.writeFile(globalPath, JSON.stringify(merged, null, 2), 'utf-8');
  }

  /** 保存配置到项目级配置文件 */
  async saveProjectConfig(config: Partial<AgentConfig>): Promise<void> {
    const projectConfigPath = this.getProjectConfigPath();
    if (!projectConfigPath) return;

    const dir = path.dirname(projectConfigPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(projectConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /** 从 .env 文件加载所有 API Key 到 process.env（全局 + 项目级） */
  async loadEnvKeys(): Promise<void> {
    // 1. 加载全局 .env
    await this.loadEnvFile(this.getEnvPath());

    // 2. 加载项目级 .env（覆盖全局）
    const projectEnvPath = this.getProjectEnvPath();
    if (projectEnvPath) {
      await this.loadEnvFile(projectEnvPath);
    }

    // 3. 向安全内核注册秘密键名（只注册键名，值不经过内核）——
    //    内核在 spawn/exec 边界剥离这些键，防止 .env 密钥泄入子进程
    registerSecretKeys(Object.keys(process.env).filter((k) => this.loadedEnvKeyNames.has(k)));
  }

  /** 从指定 .env 文件加载 Key */
  private async loadEnvFile(envPath: string): Promise<void> {
    try {
      const content = await fs.readFile(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        // 项目级 .env 覆盖全局（总是设置，不检查 process.env 是否已有）
        process.env[key] = value;
        this.loadedEnvKeyNames.add(key);
      }
    } catch {
      // .env 不存在，忽略
    }
  }

  /** 保存 API Key 到全局 .env 文件（按 provider 映射 envKey） */
  async saveApiKey(provider: string, apiKey: string): Promise<void> {
    const envKey = API_KEY_MAP[provider];
    if (!envKey) return;
    await this.saveApiKeyToEnv(envKey, apiKey);
  }

  /** 保存任意 envKey 到全局 .env（生成厂商等非 LLM 凭证通用入口） */
  async saveApiKeyToEnv(envKey: string, apiKey: string): Promise<void> {
    await this.ensureDir();

    let content = '';
    try {
      content = await fs.readFile(this.getEnvPath(), 'utf-8');
    } catch {
      // 不存在，新建
    }

    const lines = content.split('\n');
    const keyLine = `${envKey}=${apiKey}`;
    const existingIndex = lines.findIndex(l => l.trim().startsWith(`${envKey}=`));

    if (existingIndex >= 0) {
      lines[existingIndex] = keyLine;
    } else {
      let lastNonEmpty = lines.length - 1;
      while (lastNonEmpty >= 0 && lines[lastNonEmpty].trim() === '') {
        lastNonEmpty--;
      }
      lines.splice(lastNonEmpty + 1, 0, keyLine);
    }

    await fs.writeFile(this.getEnvPath(), lines.join('\n') + '\n', 'utf-8');
    process.env[envKey] = apiKey;
  }

  /** 获取指定 Provider 的 API Key（从 .env 或环境变量） */
  async getApiKey(provider: string): Promise<string | undefined> {
    await this.loadEnvKeys();
    const envKey = API_KEY_MAP[provider];
    return envKey ? process.env[envKey] : undefined;
  }

  /** 获取 Provider 对应的 API Key 环境变量名 */

  /** 获取 Provider 对应的 API Key 环境变量名 */
  getApiKeyEnvName(provider: string): string | undefined {
    return API_KEY_MAP[provider];
  }
}
