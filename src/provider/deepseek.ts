import { OpenAICompatibleProvider } from './compatible.js';
import type { ProviderConfig } from '../types.js';
import { getProviderConfigLoader } from './config.js';

/**
 * DeepSeek Provider — 基于 OpenAI 兼容 API。
 *
 * DeepSeek 的 API 使用 OpenAI Chat Completions 兼容格式。
 * Endpoint: https://api.deepseek.com/v1
 *
 * 支持模型：
 *   - deepseek-v4-flash (V4 快速，1M上下文，推荐)
 *   - deepseek-v4-pro (V4 Pro，1M上下文)
 *   - deepseek-chat (即将退役，路由到 V4 Flash)
 *   - deepseek-reasoner (即将退役，路由到 V4 Flash 思考模式)
 */
export function createDeepSeekProvider(config?: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  /** DeepSeek KVCache 隔离 ID。不同角色应使用不同的 userId。 */
  userId?: string;
}): OpenAICompatibleProvider {
  const provCfg = getProviderConfigLoader().getProvider('deepseek');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: config?.baseUrl ?? provCfg?.baseUrl ?? 'https://api.deepseek.com/v1',
    model: (config?.model && config.model.trim()) ? config.model : (provCfg?.defaultModel ?? 'unknown'),
    providerType: 'deepseek',
    maxOutputTokens: config?.maxOutputTokens,
    userId: config?.userId,
  });
}

/** 从 ProviderConfig 创建 */
export function createDeepSeekFromConfig(config: ProviderConfig): OpenAICompatibleProvider {
  return createDeepSeekProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    maxOutputTokens: config.maxOutputTokens,
    userId: config.userId,
  });
}