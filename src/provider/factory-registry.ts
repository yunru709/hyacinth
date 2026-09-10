/**
 * Provider 工厂注册表 —— 单一事实源（P5-15，方案 C）
 *
 * 背景：ProviderManager 曾以 15 个硬编码 switch case + 13 个 env 检测 if + 13 个
 * 可用性 if 分散维护厂商分支，DEFAULT_PROVIDERS 元数据表（config.ts）与工厂分支
 * 键集合完全重合但各自维护——新增厂商要改 6+ 处。
 *
 * 本注册表收敛为单一事实源：
 * - create(config)        —— 从显式配置创建实例（原 switch）
 * - createFromEnv()       —— 从环境变量检测并创建（原 detectFromEnv 的 if 链）
 * - envKeys / checkAvailability —— 可用性判定（原 getAvailableProviders 的 if 链）
 * - meta                  —— 厂商元数据（DEFAULT_PROVIDERS 由此派生）
 *
 * 新增厂商只改此处一项 + provider 实现文件；types.ts 的 ProviderType 由注册表键
 * 派生，config.ts 的 DEFAULT_PROVIDERS / setup 的 API_KEY_MAP 全部自动收敛。
 *
 * ⚠️ 键序即优先级：detectFromEnv / getAvailableProviders 遍历保序
 * （Object.values / Object.entries 遵循插入序），anthropic 最优先、local 兜底。
 *
 * ⚠️ create 参数用本地 ProviderConfigLike（与 types.ts 的 ProviderConfig 结构兼容）
 * 而非直接引用 ProviderConfig——否则 ProviderType（keyof 派生）→ ProviderConfig →
 * ProviderType re-export 形成类型环（TS2456）。结构兼容性由 TS 结构化类型自动保证。
 */
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
import { getLocalProviderConfigLoader } from './local-config.js';
import { PROVIDER_META } from './provider-meta.js';

// ProviderFactoryMeta 类型与数据真源在 provider-meta.ts（模块环：工厂文件内联
// meta 会形成 config → factory-registry → 实现文件 → config 的加载环）
import type { ProviderFactoryMeta } from './provider-meta.js';
export type { ProviderFactoryMeta } from './provider-meta.js';

/**
 * 键列表 —— ProviderType 由此派生（单一事实源）。
 * 独立 const 数组：若 ProviderType 直接 keyof 工厂对象，工厂的 create 返回
 * Provider 接口（引用 ProviderType）会形成类型环（TS2456）。键列表与工厂
 * 对象分离后，ProviderType 只依赖纯字符串数组，环断开。
 */
export const PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'deepseek',
  'groq',
  'xai',
  'mistral',
  'gemini',
  'openrouter',
  'moonshot',
  'qwen',
  'zhipu',
  'minimax',
  'mimo',
  // ── 本地模型三态 ──
  'local',
  'ollama',
  'llamacpp',
] as const;

/** ProviderType —— 由键列表派生（手写 16 值联合已删除；新增厂商类型自动收敛） */
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** 工厂创建参数（与 types.ts 的 ProviderConfig 结构兼容；type 放宽为 string 以容纳运行时扩展厂商） */
export interface ProviderConfigLike {
  type: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  userId?: string;
}

/** 单个厂商的工厂描述 */
export interface ProviderFactory {
  /** 是否为本地模型后端（local/ollama/llamacpp）——fallback 走 local-config 读取，不进 DEFAULT_PROVIDERS */
  local?: boolean;
  /** 从显式配置创建 Provider 实例（llamacpp 等仅后端、不可直接创建的抛错） */
  create(config: ProviderConfigLike): Provider;
  /** 从环境变量检测并创建；无对应 key 返回 null。仅主检测（detectFromEnv）遍历。 */
  createFromEnv?(): Provider | null;
  /** 可用性判定；缺省 = envKeys（或 meta.envKey）任一存在 */
  checkAvailability?(): boolean;
  /** 环境变量名集合（任一存在即可判定可用）。默认 [meta.envKey]。 */
  envKeys?: string[];
  /** 厂商元数据。在线厂商必填；local 三态不提供 → 自动排除出 DEFAULT_PROVIDERS */
  meta?: ProviderFactoryMeta;
}

/** 本地模型兜底：读 local-config（配置存在且有默认模型才可用） */
function detectLocalFromConfig(): Provider | null {
  try {
    const localCfg = getLocalProviderConfigLoader();
    if (localCfg?.defaultModel) {
      return new LocalProvider({ baseUrl: localCfg.baseUrl, model: localCfg.defaultModel });
    }
  } catch {
    // 配置不存在或无法加载，跳过
  }
  return null;
}

/**
 * 注册表 —— 键序即优先级（与旧 detectFromEnv / getAvailableProviders 完全一致）：
 * anthropic → openai → deepseek → groq → xai → mistral → gemini → openrouter →
 * moonshot → qwen → zhipu → minimax → mimo → local（兜底）→ ollama → llamacpp
 *
 * 注解 Record<ProviderType, ProviderFactory>：对象字面量多余键报 TS2353、
 * 漏键报 TS2741 —— 键集合与 ProviderType 编译期双向强制。
 */
export const PROVIDER_FACTORIES: Record<ProviderType, ProviderFactory> = {
  anthropic: {
    create: (config: ProviderConfigLike) =>
      new AnthropicProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model }),
    createFromEnv: () =>
      process.env.ANTHROPIC_API_KEY
        ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, baseUrl: process.env.ANTHROPIC_BASE_URL })
        : null,
    meta: PROVIDER_META.anthropic,
  },
  openai: {
    create: (config: ProviderConfigLike) =>
      new OpenAIProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        userId: config.userId,
      }),
    createFromEnv: () =>
      process.env.OPENAI_API_KEY
        ? new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL })
        : null,
    meta: PROVIDER_META.openai,
  },
  deepseek: {
    create: (config: ProviderConfigLike) => createDeepSeekFromConfig(config),
    createFromEnv: () =>
      process.env.DEEPSEEK_API_KEY
        ? createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL })
        : null,
    meta: PROVIDER_META.deepseek,
  },
  groq: {
    create: (config: ProviderConfigLike) =>
      createGroqProvider({ apiKey: config.apiKey, model: config.model, userId: config.userId }),
    createFromEnv: () => (process.env.GROQ_API_KEY ? createGroqProvider() : null),
    meta: PROVIDER_META.groq,
  },
  xai: {
    create: (config: ProviderConfigLike) =>
      createXAIProvider({ apiKey: config.apiKey, model: config.model, userId: config.userId }),
    createFromEnv: () => (process.env.XAI_API_KEY ? createXAIProvider() : null),
    meta: PROVIDER_META.xai,
  },
  mistral: {
    create: (config: ProviderConfigLike) =>
      createMistralProvider({ apiKey: config.apiKey, model: config.model, userId: config.userId }),
    createFromEnv: () => (process.env.MISTRAL_API_KEY ? createMistralProvider() : null),
    meta: PROVIDER_META.mistral,
  },
  gemini: {
    create: (config: ProviderConfigLike) =>
      new GeminiProvider({ apiKey: config.apiKey, model: config.model }),
    createFromEnv: () =>
      process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? new GeminiProvider() : null,
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    meta: PROVIDER_META.gemini,
  },
  openrouter: {
    create: (config: ProviderConfigLike) =>
      createOpenRouterProvider({ apiKey: config.apiKey, model: config.model, userId: config.userId }),
    createFromEnv: () => (process.env.OPENROUTER_API_KEY ? createOpenRouterProvider() : null),
    meta: PROVIDER_META.openrouter,
  },
  moonshot: {
    create: (config: ProviderConfigLike) =>
      createMoonshotProvider({ apiKey: config.apiKey, model: config.model, userId: config.userId }),
    createFromEnv: () => (process.env.MOONSHOT_API_KEY ? createMoonshotProvider() : null),
    meta: PROVIDER_META.moonshot,
  },
  qwen: {
    create: (config: ProviderConfigLike) => createQwenFromConfig(config),
    createFromEnv: () => (process.env.DASHSCOPE_API_KEY ? createQwenProvider() : null),
    meta: PROVIDER_META.qwen,
  },
  zhipu: {
    create: (config: ProviderConfigLike) => createZhipuFromConfig(config),
    createFromEnv: () => (process.env.ZHIPU_API_KEY ? createZhipuProvider() : null),
    meta: PROVIDER_META.zhipu,
  },
  minimax: {
    create: (config: ProviderConfigLike) => createMiniMaxFromConfig(config),
    createFromEnv: () => (process.env.MINIMAX_API_KEY ? createMiniMaxProvider() : null),
    meta: PROVIDER_META.minimax,
  },
  mimo: {
    create: (config: ProviderConfigLike) => createMiMoFromConfig(config),
    createFromEnv: () => (process.env.MIMO_API_KEY ? createMiMoProvider() : null),
    meta: PROVIDER_META.mimo,
  },
  // ── 本地模型三态（不进 DEFAULT_PROVIDERS；仅 local 参与主检测兜底） ──
  local: {
    local: true,
    create: (config: ProviderConfigLike) => new LocalProvider({ baseUrl: config.baseUrl, model: config.model }),
    createFromEnv: detectLocalFromConfig,
    checkAvailability: () => Boolean(detectLocalFromConfig()),
  },
  ollama: {
    local: true,
    create: (config: ProviderConfigLike) =>
      new LocalProvider({ baseUrl: config.baseUrl, model: config.model, backend: 'ollama' }),
  },
  llamacpp: {
    local: true,
    create: () => {
      throw new Error('llamacpp is a local backend, not a directly creatable provider type');
    },
  },
};

// ─── 运行时扩展注册表（B-3：厂商工厂可运行时外置） ─────────────────

/** 运行时注册的扩展厂商（string 键，不受 ProviderType 闭合联合限制） */
const extendedFactories = new Map<string, ProviderFactory>();

/** 合并查询：扩展优先，回退内置 */
export function getProviderFactory(type: string): ProviderFactory | undefined {
  return extendedFactories.get(type) ?? PROVIDER_FACTORIES[type as ProviderType];
}

/** 合并遍历（detectFromEnv / getAvailableProviders 用）：内置键序优先，扩展殿后 */
export function listProviderFactories(): Array<[string, ProviderFactory]> {
  return [
    ...Object.entries(PROVIDER_FACTORIES) as Array<[string, ProviderFactory]>,
    ...extendedFactories.entries(),
  ];
}

/**
 * 运行时注册厂商 —— 与 Pipeline.registerStageModule 同原语（B-1 复用）。
 * - type 已存在（含内置）：保存旧值，dispose 恢复 —— 「卸载回滚」
 * - type 不存在：新增注册，dispose 删除
 * 注册后 ProviderManager 三链（create/detect/getAvailable）自动纳入（合并查询）。
 */
export function registerProviderFactory(type: string, factory: ProviderFactory): { dispose(): void } {
  const had = extendedFactories.has(type);
  const previous = extendedFactories.get(type);
  extendedFactories.set(type, factory);
  return {
    dispose: () => {
      if (had) extendedFactories.set(type, previous!);
      else extendedFactories.delete(type);
    },
  };
}
