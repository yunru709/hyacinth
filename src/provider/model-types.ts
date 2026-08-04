/**
 * 模型类型定义 —— 独立文件，避免 provider/config.ts 与 model-catalog-loader.ts 循环依赖。
 *
 * 模型数据统一存放于 provider 配置（providers.json / DEFAULT_PROVIDERS）的 models 字段，
 * ModelCatalogLoader 负责从 ProviderConfigLoader 聚合。
 */

/** 模型目录条目 */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  /** 最大输入上下文窗口（token 数） */
  contextWindow: number;
  /** 单次请求最大输出 token 数（区别于 contextWindow 输入上限）。兼容旧键名 maxTokens。 */
  maxOutputTokens: number;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    thinking: boolean;
    vision: boolean;
    inputTypes: string[];
  };
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  status: string;
  replacedBy?: string;
  reasoning?: boolean;
  /** 推理/思考强度：high | max（仅 DeepSeek V4 等支持 reasoning 的模型有效） */
  reasoningEffort?: 'high' | 'max';
}

/** 模型目录配置（兼容旧 models-catalog.json 结构） */
export interface ModelsCatalogConfig {
  models: ModelCatalogEntry[];
}

/**
 * 模型目录 —— 单一事实源（按 provider 分组）。
 *
 * 模型数据统一维护于此，DEFAULT_PROVIDERS 的每个 provider 通过 MODEL_CATALOG[id] 挂载，
 * ModelCatalogLoader 从 ProviderConfigLoader 聚合后返回。厂商更新模型只需改这里。
 */
export const MODEL_CATALOG: Record<string, ModelCatalogEntry[]> = {
  anthropic: [
    { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, status: 'available' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, status: 'available' },
    { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, status: 'available' },
    { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, status: 'deprecated', replacedBy: 'claude-opus-5' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, status: 'deprecated', replacedBy: 'claude-sonnet-5' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, status: 'deprecated', replacedBy: 'claude-opus-5' },
    { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, status: 'available' },
    { id: 'claude-haiku-4-20250514', name: 'Claude Haiku 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 32000, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'deprecated', replacedBy: 'claude-haiku-4.5' },
  ],
  openai: [
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai', contextWindow: 1050000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125 }, status: 'available' },
    { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', contextWindow: 1050000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 5, output: 30, cacheRead: 0.5 }, status: 'available' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai', contextWindow: 400000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 0.75, output: 4.5, cacheRead: 0.075 }, status: 'available' },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'deprecated', replacedBy: 'gpt-5.4-mini' },
    { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', contextWindow: 1047576, maxOutputTokens: 32768, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'deprecated', replacedBy: 'gpt-5.5' },
  ],
  deepseek: [
    { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731', provider: 'deepseek', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, cost: { input: 0.09, output: 0.18, cacheRead: 0.018 }, status: 'available', reasoning: true, reasoningEffort: 'high' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', contextWindow: 1048576, maxOutputTokens: 384000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, cost: { input: 0.435, output: 0.87, cacheRead: 0.003625 }, status: 'available', reasoning: true, reasoningEffort: 'max' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, cost: { input: 0.09, output: 0.18, cacheRead: 0.018 }, status: 'deprecated', replacedBy: 'deepseek-v4-flash-0731', reasoning: true, reasoningEffort: 'high' },
  ],
  gemini: [
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'gemini', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document', 'audio', 'video'] }, cost: { input: 1.5, output: 7.5, cacheRead: 0.15 }, status: 'available' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'gemini', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document', 'audio', 'video'] }, cost: { input: 1.5, output: 9, cacheRead: 0.15 }, status: 'available' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', provider: 'gemini', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document', 'audio', 'video'] }, cost: { input: 0.25, output: 1.5, cacheRead: 0.025 }, status: 'available' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, status: 'deprecated', replacedBy: 'gemini-3.6-flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, status: 'deprecated', replacedBy: 'gemini-3.6-flash' },
  ],
  groq: [
    { id: 'llama-4-maverick', name: 'Llama 4 Maverick', provider: 'groq', contextWindow: 131072, maxOutputTokens: 16384, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] }, status: 'available' },
  ],
  xai: [
    { id: 'grok-4.5', name: 'Grok 4.5', provider: 'xai', contextWindow: 500000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 2, output: 6, cacheRead: 0.3 }, status: 'available' },
    { id: 'grok-4.3', name: 'Grok 4.3', provider: 'xai', contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 1.25, output: 2.5, cacheRead: 0.2 }, status: 'available' },
    { id: 'grok-4', name: 'Grok 4', provider: 'xai', contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'deprecated', replacedBy: 'grok-4.5' },
  ],
  mistral: [
    { id: 'mistral-large-2512', name: 'Mistral Large 3', provider: 'mistral', contextWindow: 262144, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 0.5, output: 1.5, cacheRead: 0.05 }, status: 'available' },
    { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5', provider: 'mistral', contextWindow: 262144, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, cost: { input: 1.5, output: 7.5 }, status: 'available' },
    { id: 'mistral-small-2603', name: 'Mistral Small 4', provider: 'mistral', contextWindow: 262144, maxOutputTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image'] }, cost: { input: 0.15, output: 0.6, cacheRead: 0.015 }, status: 'available' },
    { id: 'mistral-large-latest', name: 'Mistral Large', provider: 'mistral', contextWindow: 131072, maxOutputTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] }, status: 'deprecated', replacedBy: 'mistral-large-2512' },
  ],
  openrouter: [
    { id: 'openrouter/auto', name: 'OpenRouter Auto', provider: 'openrouter', contextWindow: 200000, maxOutputTokens: 4096, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] }, status: 'available' },
  ],
  moonshot: [
    { id: 'kimi-k3', name: 'Kimi K3', provider: 'moonshot', contextWindow: 1048576, maxOutputTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image'] }, cost: { input: 3, output: 15, cacheRead: 0.3 }, status: 'available' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'moonshot', contextWindow: 262144, maxOutputTokens: 262144, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image'] }, cost: { input: 0.57, output: 2.85, cacheRead: 0.095 }, status: 'available' },
    { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K', provider: 'moonshot', contextWindow: 128000, maxOutputTokens: 4096, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] }, status: 'deprecated', replacedBy: 'kimi-k2.5' },
  ],
  qwen: [
    { id: 'qwen3.8-max', name: 'Qwen3.8 Max', provider: 'qwen', contextWindow: 1000000, maxOutputTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'video'] }, cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 }, status: 'available' },
    { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', provider: 'qwen', contextWindow: 1000000, maxOutputTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image'] }, cost: { input: 0.32, output: 1.28, cacheRead: 0.064, cacheWrite: 0.4 }, status: 'available' },
    { id: 'qwen3.7-flash', name: 'Qwen3.7 Flash', provider: 'qwen', contextWindow: 1000000, maxOutputTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'video'] }, cost: { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038 }, status: 'available' },
    { id: 'qwen3-vl-plus', name: 'Qwen3 VL Plus', provider: 'qwen', contextWindow: 131072, maxOutputTokens: 8192, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'deprecated', replacedBy: 'qwen3.7-plus' },
  ],
  zhipu: [
    { id: 'glm-5.2', name: 'GLM-5.2', provider: 'zhipu', contextWindow: 262144, maxOutputTokens: 262144, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, cost: { input: 0.76, output: 2.42, cacheRead: 0.14 }, status: 'available' },
    { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', provider: 'zhipu', contextWindow: 202752, maxOutputTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'video'] }, cost: { input: 1.2, output: 4, cacheRead: 0.24 }, status: 'available' },
    { id: 'glm-5', name: 'GLM-5', provider: 'zhipu', contextWindow: 204800, maxOutputTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, cost: { input: 0.95, output: 2.55, cacheRead: 0.2 }, status: 'available' },
    { id: 'glm-4.6v', name: 'GLM-4.6V', provider: 'zhipu', contextWindow: 128000, maxOutputTokens: 4096, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'deprecated', replacedBy: 'glm-5v-turbo' },
  ],
  minimax: [
    { id: 'MiniMax-M3', name: 'MiniMax M3', provider: 'minimax', contextWindow: 524288, maxOutputTokens: 512000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'video'] }, cost: { input: 0.3, output: 1.2, cacheRead: 0.06 }, status: 'available' },
  ],
  mimo: [
    { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', provider: 'mimo', contextWindow: 1048576, maxOutputTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, cost: { input: 0.435, output: 0.87, cacheRead: 0.0036 }, status: 'available' },
    { id: 'mimo-v2.5', name: 'MiMo V2.5', provider: 'mimo', contextWindow: 1048576, maxOutputTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'audio', 'video'] }, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 }, status: 'available' },
  ],
};

