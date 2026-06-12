/**
 * Qwen (阿里百炼) Provider — Anthropic 兼容协议。
 *
 * 阿里百炼的 Anthropic 兼容端点接受标准 Anthropic Messages API 格式，
 * 支持 cache_control、thinking、tool_use 等全部 Anthropic 特性。
 *
 * 端点: https://dashscope.aliyuncs.com/apps/anthropic
 * 认证: x-api-key 头（DASHSCOPE_API_KEY）
 */

import { AnthropicProvider } from './anthropic.js';
import type { AnthropicProviderOptions } from './anthropic.js';
import type { ProviderConfig } from '../types.js';
import { getProviderConfigLoader } from './config.js';

export function createQwenProvider(config?: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): AnthropicProvider {
  const provCfg = getProviderConfigLoader().getProvider('qwen');
  return new AnthropicProvider({
    apiKey: config?.apiKey ?? process.env.DASHSCOPE_API_KEY,
    baseUrl: config?.baseUrl ?? provCfg?.baseUrl ?? 'https://dashscope.aliyuncs.com/apps/anthropic',
    model: config?.model ?? provCfg?.defaultModel ?? 'qwen3-vl-plus',
    maxTokens: provCfg?.maxTokens ?? 8192,
    providerType: 'qwen',
  } satisfies AnthropicProviderOptions);
}

export function createQwenFromConfig(config: ProviderConfig): AnthropicProvider {
  return createQwenProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
  });
}
