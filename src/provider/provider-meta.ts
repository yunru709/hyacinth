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
   * 兼容协议声明 —— "该厂商走哪套协议"的**单一真源**。
   *
   * - JSON 声明厂商：由本字段决定 factory-registry 用哪套实现（缺省 openai）。
   * - 内置厂商：**同样在此声明**。可用性探测器（`probe.ts`）据此拼端点，
   *   不必再维护一份"哪些厂商是 anthropic 协议"的硬编码名单
   *   —— 那份名单漏加一次，新增厂商就会被按 OpenAI 路径探测 ⇒ 误判为不可用（静默）。
   * - `gemini` 为 Google 专有协议，不在此二元取值内（probe 按 type 特判）。
   *
   * 注：当前多数厂商**同时提供两种协议的端点**（如 qwen 走 anthropic 兼容、
   * zhipu 走 openai 兼容），故本字段取值是"接入选型"而非"厂商能力上限"。
   */
  protocol?: 'openai' | 'anthropic';
  /**
   * 该厂商接受 DeepSeek 私有的 `thinking` / `reasoning_effort` 请求字段。
   *
   * 缺省策略：**仅 `deepseek` 官方发送**（见 `compatible.ts`），其余厂商不再被塞入
   * 未知字段 —— 历史上这类"照着 DeepSeek 抄"的私有字段会外溢给所有 OpenAI 兼容厂商
   * （宽松网关忽略、严格网关直接 400）。
   * 跑 DeepSeek 模型的中转站（如 opencode / commandcode）若也接受，可显式置 `true`。
   */
  deepseekThinking?: boolean;
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
    protocol: 'anthropic',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
    envKey: 'OPENAI_API_KEY',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    // 2026-10-02：官方模型表已改名为 deepseek-flash（显示名 DeepSeek-V4.1-Flash）/ deepseek-v4-pro。
    // 旧名 deepseek-v4-flash 已从官方 /models 列表消失。
    defaultModel: 'deepseek-flash',
    envKey: 'DEEPSEEK_API_KEY',
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-4-maverick',
    envKey: 'GROQ_API_KEY',
  },
  xai: {
    id: 'xai',
    name: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.5',
    envKey: 'XAI_API_KEY',
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-2512',
    envKey: 'MISTRAL_API_KEY',
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-3.6-flash',
    envKey: 'GEMINI_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    envKey: 'OPENROUTER_API_KEY',
    /** OpenRouter 官方接受标准 user（而非 DeepSeek 的 user_id）——厂商级默认覆盖，可在 providers.json 改 */
    fieldMap: { userId: 'user' },
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3',
    envKey: 'MOONSHOT_API_KEY',
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen (阿里百炼)',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3.7-plus',
    envKey: 'DASHSCOPE_API_KEY',
    protocol: 'anthropic',
  },
  zhipu: {
    id: 'zhipu',
    name: 'Zhipu (智谱)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.2',
    envKey: 'ZHIPU_API_KEY',
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M3',
    envKey: 'MINIMAX_API_KEY',
    protocol: 'anthropic',
  },
  mimo: {
    id: 'mimo',
    name: 'MiMo (小米)',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    defaultModel: 'mimo-v2.5',
    envKey: 'MIMO_API_KEY',
    protocol: 'anthropic',
  },
  volcengine: {
    id: 'volcengine',
    name: 'Volcengine (火山方舟)',
    // Agent/Coding Plan 专属端点：Plan 专属 API Key 仅在此端点生效（打通用端点报 401）。
    // 通用 API Key 用户需覆盖 baseUrl 为 https://ark.cn-beijing.volces.com/api/v3，
    // 并改用带日期后缀的 Model ID（如 doubao-seed-2-1-pro-260628）
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    // 与 providers.json 的 volcengine.defaultModel 对齐。
    // ⚠️ 此处的名字属**火山 Plan 端点短名体系**（doubao-seed-* / deepseek-v4.1-flash …），
    // 与 DeepSeek 官方的 id（deepseek-flash）不是同一套，别互相套用。
    defaultModel: 'doubao-seed-evolving',
    envKey: 'ARK_API_KEY',
  },
};

/**
 * 模型列表自动挂载（2026-10-02）。
 *
 * 此前每家厂商都要在本文件里手写一行 `models: MODEL_CATALOG.<id>` —— 新增厂商得动两处，
 * 而"忘挂"的后果是**静默的**：那家厂商不报错，只是模型列表为空。
 *
 * 现改为按厂商名自动挂载：MODEL_CATALOG 仍是模型数据的唯一来源，这里只负责"接上线"，
 * 所以它与 DEFAULT_PROVIDERS 的 models 依然**是同一个数组对象**（守卫测试的 toBe 继续成立）。
 *
 * 手写优先：若某家已显式声明 models（将来若要给个别厂商裁剪子集），不覆盖。
 */
for (const [id, meta] of Object.entries(PROVIDER_META)) {
  if (!meta.models && MODEL_CATALOG[id]) meta.models = MODEL_CATALOG[id];
}
