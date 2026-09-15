/**
 * 厂商元数据 —— 单一真源（P5-15，方案 C）
 *
 * 从 factory-registry 独立成文件的原因：实现文件（anthropic.ts 等）运行时查询
 * 默认 baseUrl/defaultModel 依赖 config.ts 的 getProviderConfigLoader，而 config.ts
 * 的 DEFAULT_PROVIDERS 派生自注册表——若 meta 内联在 factory-registry，会形成
 * config → factory-registry → 实现文件 → config 的模块加载环（TDZ）。
 *
 * meta 独立后依赖图无环：factory-registry 与 config.ts 都引用本文件的 PROVIDER_META，
 * 实现文件 → config → provider-meta 单向。三处同源由 factory-registry.test.ts
 * 的守卫测试锁死（对象引用一致）。
 */
import { MODEL_CATALOG } from './model-types.js';
import type { ModelCatalogEntry } from './model-types.js';
import type { ProviderFields, ProviderSampling } from './fields.js';

/** 非 chat 能力类型（chat 由 LLM 体系天然承载，无需声明） */
export type VendorCapability = 'tts' | 'image' | 'video' | 'embedding' | 'rerank';

/**
 * 非 chat 能力声明（多能力厂商/中转站：一个 key 背后多个能力）。
 * 声明后生成侧自动继承（vendor auto-materialize）：无需重复写 generation.json。
 */
export interface VendorCapabilitySpec {
  /** 生成侧适配器类型；缺省：tts/image → 'openai-compatible'；video 无 OpenAI 标准，需显式 adapter */
  adapter?: string;
  /** 该能力默认模型 */
  model?: string;
  /** TTS 默认音色 */
  voice?: string;
}

/** 厂商元数据（原 config.ts 的 ProviderMeta；DEFAULT_PROVIDERS 由此派生） */
export interface ProviderFactoryMeta {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  envKey: string;
  /** 该厂商支持的模型列表（数据源：MODEL_CATALOG） */
  models?: ModelCatalogEntry[];
  /**
   * 兼容协议（仅 JSON 声明厂商使用；内置厂商由各自实现文件决定）。
   * openai = OpenAI Chat Completions（默认），anthropic = Anthropic Messages API。
   */
  protocol?: 'openai' | 'anthropic';
  /** 厂商级默认采样参数（JSON 声明厂商用；激活配置未覆盖时生效） */
  sampling?: ProviderSampling;
  /** 通用字段 → wire 字段名覆盖（如 OpenAI 兼容端点用标准 user：{ "userId": "user" }） */
  fieldMap?: Partial<Record<keyof ProviderFields, string>>;
  /** 多能力声明（缺省 = 仅 chat）。声明后生成侧 auto-materialize 自动继承。 */
  capabilities?: Partial<Record<VendorCapability, VendorCapabilitySpec>>;
}

/** 14 在线厂商元数据（local 三态不在列——不进 DEFAULT_PROVIDERS） */
export const PROVIDER_META: Record<string, ProviderFactoryMeta> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    envKey: 'ANTHROPIC_API_KEY',
    models: MODEL_CATALOG.anthropic,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
    envKey: 'OPENAI_API_KEY',
    models: MODEL_CATALOG.openai,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    envKey: 'DEEPSEEK_API_KEY',
    models: MODEL_CATALOG.deepseek,
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-4-maverick',
    envKey: 'GROQ_API_KEY',
    models: MODEL_CATALOG.groq,
  },
  xai: {
    id: 'xai',
    name: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.5',
    envKey: 'XAI_API_KEY',
    models: MODEL_CATALOG.xai,
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-2512',
    envKey: 'MISTRAL_API_KEY',
    models: MODEL_CATALOG.mistral,
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-3.6-flash',
    envKey: 'GEMINI_API_KEY',
    models: MODEL_CATALOG.gemini,
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    envKey: 'OPENROUTER_API_KEY',
    models: MODEL_CATALOG.openrouter,
    /** OpenRouter 官方接受标准 user（而非 DeepSeek 的 user_id）——厂商级默认覆盖，可在 providers.json 改 */
    fieldMap: { userId: 'user' },
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3',
    envKey: 'MOONSHOT_API_KEY',
    models: MODEL_CATALOG.moonshot,
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen (阿里百炼)',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3.7-plus',
    envKey: 'DASHSCOPE_API_KEY',
    models: MODEL_CATALOG.qwen,
  },
  zhipu: {
    id: 'zhipu',
    name: 'Zhipu (智谱)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.2',
    envKey: 'ZHIPU_API_KEY',
    models: MODEL_CATALOG.zhipu,
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M3',
    envKey: 'MINIMAX_API_KEY',
    models: MODEL_CATALOG.minimax,
  },
  mimo: {
    id: 'mimo',
    name: 'MiMo (小米)',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    defaultModel: 'mimo-v2.5',
    envKey: 'MIMO_API_KEY',
    models: MODEL_CATALOG.mimo,
  },
  volcengine: {
    id: 'volcengine',
    name: 'Volcengine (火山方舟)',
    // Agent/Coding Plan 专属端点：Plan 专属 API Key 仅在此端点生效（打通用端点报 401）。
    // 通用 API Key 用户需覆盖 baseUrl 为 https://ark.cn-beijing.volces.com/api/v3，
    // 并改用带日期后缀的 Model ID（如 doubao-seed-2-1-pro-260628）
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    defaultModel: 'deepseek-v4-flash',
    envKey: 'ARK_API_KEY',
    models: MODEL_CATALOG.volcengine,
  },
};
