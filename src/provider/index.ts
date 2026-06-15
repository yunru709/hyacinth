// Provider 模块统一导出

// 接口
export type { Provider, ProviderCapabilities } from './interface.js';

// Anthropic Provider
export { AnthropicProvider, createAnthropicProvider } from './anthropic.js';
export type { AnthropicProviderOptions } from './anthropic.js';

// OpenAI Provider
export { OpenAIProvider, createOpenAIProvider } from './openai.js';
export type { OpenAIProviderOptions } from './openai.js';

// DeepSeek Provider (OpenAI 兼容)
export { createDeepSeekProvider, createDeepSeekFromConfig } from './deepseek.js';

// Local Provider
export { LocalProvider, createLocalProvider } from './local.js';
export type { LocalProviderOptions } from './local.js';

// LlamaCpp Provider
export { LlamaCppProvider, createLlamaCppProvider } from '../local-model/llamacpp-provider.js';
export type { LlamaCppOptions } from '../local-model/llamacpp-provider.js';

// Provider Router
export { ProviderRouter } from './router.js';
export type { AssessmentInput, RoutingInfo } from './router.js';

// OpenAI-Compatible Providers (Groq, xAI, Mistral, OpenRouter, Moonshot)
export {
  OpenAICompatibleProvider,
  createGroqProvider,
  createXAIProvider,
  createMistralProvider,
  createOpenRouterProvider,
  createMoonshotProvider,
} from './compatible.js';
export type { OpenAICompatibleOptions } from './compatible.js';

// Google Gemini
export { GeminiProvider, createGeminiProvider } from './gemini.js';
export type { GeminiProviderOptions } from './gemini.js';

// Qwen (阿里百炼) — Anthropic 兼容
export { createQwenProvider, createQwenFromConfig } from './qwen.js';

// Zhipu (智谱) — OpenAI 兼容
export { createZhipuProvider, createZhipuFromConfig } from './zhipu.js';

// MiniMax — Anthropic 兼容
export { createMiniMaxProvider, createMiniMaxFromConfig } from './minimax.js';

// MiMo (小米) — Anthropic 兼容
export { createMiMoProvider, createMiMoFromConfig } from './mimo.js';

// Provider Manager
export { ProviderManager } from './manager.js';
export type { ProviderManagerOptions } from './manager.js';

// Resilience (retry + circuit breaker)
export { ResilientProvider, DEFAULT_CB } from './resilient.js';
export type { CircuitBreakerConfig } from './resilient.js';

// Fallback chain
export { FallbackProviderChain } from './fallback.js';
export type { FallbackChainConfig } from './fallback.js';

// Retry utilities
export { withRetry, isRetryableError, isNonRetryableError, DEFAULT_RETRY_CONFIG } from './retry.js';

// Model Catalog
export { ModelCatalog, modelCatalog, getModelInfo } from './catalog.js';
export type { ModelInfo, ModelCapabilities, ModelCost } from './catalog.js';

// Model Catalog Loader
export { ModelCatalogLoader, getModelCatalogLoader } from './model-catalog-loader.js';
export type { ModelCatalogEntry, ModelsCatalogConfig } from './model-catalog-loader.js';

// Model Router
export { ModelRouter } from './model-router.js';
export type { ModelRole, ModelSourceConfig, ModelsConfig, LocalModelConfig } from './model-router.js';

// Model Channel Registry
export { ModelChannelRegistry } from './model-channel-registry.js';
export type { ChannelConfig, ModelChannelsConfig } from './model-channel-registry.js';
