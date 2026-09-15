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
 * 三层查询（getProviderFactory / listProviderFactories）：
 *   1. 运行时扩展（registerProviderFactory，B-3）
 *   2. 内置注册表（PROVIDER_FACTORIES，本文件）
 *   3. JSON 声明兜底（~/.agent/providers.json，零代码接入，见 createJsonDeclaredFactory）
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
  createVolcengineProvider,
  OpenAICompatibleProvider,
} from './compatible.js';
import { GeminiProvider } from './gemini.js';
import { createQwenProvider, createQwenFromConfig } from './qwen.js';
import { createZhipuProvider, createZhipuFromConfig } from './zhipu.js';
import { createMiniMaxProvider, createMiniMaxFromConfig } from './minimax.js';
import { createMiMoProvider, createMiMoFromConfig } from './mimo.js';
import { getLocalProviderConfigLoader } from './local-config.js';
import { getProviderConfigLoader } from './config.js';
import { PROVIDER_META } from './provider-meta.js';
import type { ProviderFields, ProviderSampling } from './fields.js';

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
  'volcengine',
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
  /** 单次请求最大输出 token 数（不传则从模型目录自动获取） */
  maxOutputTokens?: number;
  /** 通用字段（userId 等；工厂层归一 userId 进 fields） */
  fields?: ProviderFields;
  /** 采样参数（temperature/topP/penalties；让配置生效） */
  sampling?: ProviderSampling;
  /** 通用字段 → wire 字段名覆盖（缺省从厂商 meta.fieldMap 解析，providers.json 可配置） */
  fieldMap?: Partial<Record<keyof ProviderFields, string>>;
}

/**
 * 解析厂商的 wire 字段名覆盖（映射数据化）。
 * 优先用户配置（providers.json 覆盖内置 meta），回退内置 PROVIDER_META。
 * loader 未初始化（启动早期）时回退内置对象；内置未声明 → undefined（走代码默认 PROTOCOL_FIELD_MAP）。
 */
function resolveFieldMap(type: string): Partial<Record<keyof ProviderFields, string>> | undefined {
  try {
    return getProviderConfigLoader().getProvider(type)?.fieldMap ?? PROVIDER_META[type]?.fieldMap;
  } catch {
    return PROVIDER_META[type]?.fieldMap;
  }
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
      new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
        fields: config.fields,
        sampling: config.sampling,
        fieldMap: config.fieldMap ?? resolveFieldMap('anthropic'),
      }),
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
        maxOutputTokens: config.maxOutputTokens,
        fields: config.fields,
        sampling: config.sampling,
        fieldMap: config.fieldMap ?? resolveFieldMap('openai'),
      }),
    createFromEnv: () =>
      process.env.OPENAI_API_KEY
        ? new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL })
        : null,
    meta: PROVIDER_META.openai,
  },
  deepseek: {
    create: (config: ProviderConfigLike) => createDeepSeekFromConfig(config, config.fieldMap ?? resolveFieldMap('deepseek')),
    createFromEnv: () =>
      process.env.DEEPSEEK_API_KEY
        ? createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL })
        : null,
    meta: PROVIDER_META.deepseek,
  },
  groq: {
    create: (config: ProviderConfigLike) =>
      createGroqProvider({
        apiKey: config.apiKey, model: config.model, userId: config.userId,
        maxOutputTokens: config.maxOutputTokens, fields: config.fields, sampling: config.sampling,
        fieldMap: config.fieldMap ?? resolveFieldMap('groq'),
      }),
    createFromEnv: () => (process.env.GROQ_API_KEY ? createGroqProvider() : null),
    meta: PROVIDER_META.groq,
  },
  xai: {
    create: (config: ProviderConfigLike) =>
      createXAIProvider({
        apiKey: config.apiKey, model: config.model, userId: config.userId,
        maxOutputTokens: config.maxOutputTokens, fields: config.fields, sampling: config.sampling,
        fieldMap: config.fieldMap ?? resolveFieldMap('xai'),
      }),
    createFromEnv: () => (process.env.XAI_API_KEY ? createXAIProvider() : null),
    meta: PROVIDER_META.xai,
  },
  mistral: {
    create: (config: ProviderConfigLike) =>
      createMistralProvider({
        apiKey: config.apiKey, model: config.model, userId: config.userId,
        maxOutputTokens: config.maxOutputTokens, fields: config.fields, sampling: config.sampling,
        fieldMap: config.fieldMap ?? resolveFieldMap('mistral'),
      }),
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
      createOpenRouterProvider({
        apiKey: config.apiKey, model: config.model, userId: config.userId,
        maxOutputTokens: config.maxOutputTokens, fields: config.fields, sampling: config.sampling,
        fieldMap: config.fieldMap ?? resolveFieldMap('openrouter'),
      }),
    createFromEnv: () => (process.env.OPENROUTER_API_KEY ? createOpenRouterProvider() : null),
    meta: PROVIDER_META.openrouter,
  },
  moonshot: {
    create: (config: ProviderConfigLike) =>
      createMoonshotProvider({
        apiKey: config.apiKey, model: config.model, userId: config.userId,
        maxOutputTokens: config.maxOutputTokens, fields: config.fields, sampling: config.sampling,
        fieldMap: config.fieldMap ?? resolveFieldMap('moonshot'),
      }),
    createFromEnv: () => (process.env.MOONSHOT_API_KEY ? createMoonshotProvider() : null),
    meta: PROVIDER_META.moonshot,
  },
  qwen: {
    create: (config: ProviderConfigLike) => createQwenFromConfig(config, config.fieldMap ?? resolveFieldMap('qwen')),
    createFromEnv: () => (process.env.DASHSCOPE_API_KEY ? createQwenProvider() : null),
    meta: PROVIDER_META.qwen,
  },
  zhipu: {
    create: (config: ProviderConfigLike) => createZhipuFromConfig(config, config.fieldMap ?? resolveFieldMap('zhipu')),
    createFromEnv: () => (process.env.ZHIPU_API_KEY ? createZhipuProvider() : null),
    meta: PROVIDER_META.zhipu,
  },
  minimax: {
    create: (config: ProviderConfigLike) => createMiniMaxFromConfig(config, config.fieldMap ?? resolveFieldMap('minimax')),
    createFromEnv: () => (process.env.MINIMAX_API_KEY ? createMiniMaxProvider() : null),
    meta: PROVIDER_META.minimax,
  },
  mimo: {
    create: (config: ProviderConfigLike) => createMiMoFromConfig(config, config.fieldMap ?? resolveFieldMap('mimo')),
    createFromEnv: () => (process.env.MIMO_API_KEY ? createMiMoProvider() : null),
    meta: PROVIDER_META.mimo,
  },
  volcengine: {
    create: (config: ProviderConfigLike) =>
      createVolcengineProvider({
        apiKey: config.apiKey, model: config.model, userId: config.userId,
        maxOutputTokens: config.maxOutputTokens, fields: config.fields, sampling: config.sampling,
        fieldMap: config.fieldMap ?? resolveFieldMap('volcengine'),
      }),
    createFromEnv: () => (process.env.ARK_API_KEY ? createVolcengineProvider() : null),
    meta: PROVIDER_META.volcengine,
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

/**
 * JSON 声明厂商兜底 —— 通过 ~/.agent/providers.json 声明即可接入，无需改内核。
 *
 * 声明示例（protocol 缺省为 openai）：
 * ```json
 * { "providers": {
 *     "my_vendor": {
 *       "id": "my_vendor", "name": "My Vendor",
 *       "baseUrl": "https://api.my-vendor.com/v1",
 *       "defaultModel": "my-model", "envKey": "MY_VENDOR_API_KEY",
 *       "protocol": "openai"
 *     }
 * } }
 * ```
 * 与 registerProviderFactory（代码工厂运行时注册）互补：这是「纯声明式接入」。
 * 仅当内置/扩展均未命中且 JSON 有声明时生效；未声明返回 undefined（保持原行为）。
 */
function createJsonDeclaredFactory(type: string): ProviderFactory | undefined {
  let meta: ProviderFactoryMeta | undefined;
  try {
    meta = getProviderConfigLoader().getProvider(type);
  } catch {
    return undefined; // loader 未初始化（启动早期）——不兜底
  }
  if (!meta || !meta.baseUrl) return undefined; // 未声明或元数据不完整

  const protocol = meta.protocol ?? 'openai';
  // 归一：fields.userId ?? config.userId（工厂层单一入口，各实现无需各自合并）
  const withFields = (config: ProviderConfigLike): ProviderFields => ({
    ...config.fields,
    userId: config.fields?.userId ?? config.userId,
  });
  const build = (config: ProviderConfigLike) =>
    protocol === 'anthropic'
      ? new AnthropicProvider({
          apiKey: config.apiKey,
          baseUrl: meta!.baseUrl,
          model: config.model ?? meta!.defaultModel,
          providerType: type as ProviderType,
          maxOutputTokens: config.maxOutputTokens,
          fields: withFields(config),
          sampling: config.sampling ?? meta!.sampling,
        })
      : new OpenAICompatibleProvider({
          apiKey: config.apiKey,
          baseUrl: meta!.baseUrl,
          model: config.model ?? meta!.defaultModel,
          providerType: type as ProviderType,
          maxOutputTokens: config.maxOutputTokens,
          fields: withFields(config),
          sampling: config.sampling ?? meta!.sampling,
          fieldMap: meta!.fieldMap,
        });

  return {
    create: build,
    createFromEnv: () =>
      meta!.envKey && process.env[meta!.envKey]
        ? build({ type, apiKey: process.env[meta!.envKey]!, model: meta!.defaultModel })
        : null,
    meta,
  };
}

/** 合并查询：扩展优先 → 内置 → JSON 声明兜底 */
export function getProviderFactory(type: string): ProviderFactory | undefined {
  return extendedFactories.get(type)
    ?? PROVIDER_FACTORIES[type as ProviderType]
    ?? createJsonDeclaredFactory(type);
}

/** 合并遍历（detectFromEnv / getAvailableProviders 用）：内置键序优先，扩展殿后 */
export function listProviderFactories(): Array<[string, ProviderFactory]> {
  const declared: Array<[string, ProviderFactory]> = [];
  try {
    const all = getProviderConfigLoader().getAll();
    for (const meta of all) {
      if (meta.id in PROVIDER_FACTORIES || extendedFactories.has(meta.id)) continue;
      const factory = createJsonDeclaredFactory(meta.id);
      if (factory) declared.push([meta.id, factory]);
    }
  } catch {
    // loader 未初始化——跳过 JSON 声明厂商
  }
  return [
    ...Object.entries(PROVIDER_FACTORIES) as Array<[string, ProviderFactory]>,
    ...declared,
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
