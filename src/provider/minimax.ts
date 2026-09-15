/**
 * MiniMax Provider — Anthropic 兼容协议（推荐）。
 *
 * MiniMax M3 支持 Anthropic Messages API 格式，包括:
 *   - cache_control (ephemeral)
 *   - thinking (budget_tokens)
 *   - tool_use (native)
 *   - 图片 (base64)
 *
 * 端点: https://api.minimaxi.com/anthropic
 * 认证: Authorization: Bearer $MINIMAX_API_KEY
 */

import { AnthropicProvider } from './anthropic.js';
import type { AnthropicProviderOptions } from './anthropic.js';
import type { ProviderConfig } from '../types.js';
import type { ProviderFields } from './fields.js';
import { getProviderConfigLoader } from './config.js';

export function createMiniMaxProvider(config?: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  /** 通用字段 → wire 字段名覆盖（映射数据化：providers.json 可配置） */
  fieldMap?: Partial<Record<keyof ProviderFields, string>>;
}): AnthropicProvider {
  const provCfg = getProviderConfigLoader().getProvider('minimax');
  return new AnthropicProvider({
    apiKey: config?.apiKey ?? process.env.MINIMAX_API_KEY,
    baseUrl: config?.baseUrl ?? provCfg?.baseUrl ?? 'https://api.minimaxi.com/anthropic',
    model: config?.model ?? provCfg?.defaultModel ?? 'MiniMax-M3',
    maxOutputTokens: config?.maxOutputTokens,
    providerType: 'minimax',
    fieldMap: config?.fieldMap,
  } satisfies AnthropicProviderOptions);
}

export function createMiniMaxFromConfig(
  config: ProviderConfig,
  fieldMap?: Partial<Record<keyof ProviderFields, string>>,
): AnthropicProvider {
  return createMiniMaxProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    maxOutputTokens: config.maxOutputTokens,
    fieldMap,
  });
}
