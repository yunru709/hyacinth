/**
 * MiMo (小米) Provider — Anthropic 兼容协议。
 *
 * MiMo-V2.5 是原生全模态模型（文本+图片+视频+音频），1M 上下文，开源 MIT。
 * 推荐走 Anthropic 兼容端点，与现有 AnthropicProvider 代码完全复用。
 *
 * 端点: https://api.xiaomimimo.com/anthropic
 * 认证: api-key 头（MIMO_API_KEY）
 */

import { AnthropicProvider } from './anthropic.js';
import type { AnthropicProviderOptions } from './anthropic.js';
import type { ProviderConfig } from '../types.js';
import { getProviderConfigLoader } from './config.js';

export function createMiMoProvider(config?: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
}): AnthropicProvider {
  const provCfg = getProviderConfigLoader().getProvider('mimo');
  return new AnthropicProvider({
    apiKey: config?.apiKey ?? process.env.MIMO_API_KEY,
    baseUrl: config?.baseUrl ?? provCfg?.baseUrl ?? 'https://api.xiaomimimo.com/anthropic',
    model: config?.model ?? provCfg?.defaultModel ?? 'mimo-v2.5',
    maxOutputTokens: config?.maxOutputTokens,
    providerType: 'mimo',
  } satisfies AnthropicProviderOptions);
}

export function createMiMoFromConfig(config: ProviderConfig): AnthropicProvider {
  return createMiMoProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    maxOutputTokens: config.maxOutputTokens,
  });
}
