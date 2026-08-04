/**
 * Zhipu (智谱 / BigModel) Provider — OpenAI 兼容协议。
 *
 * GLM-5V Turbo 支持多模态视觉输入，格式与 OpenAI Chat Completions 完全一致。
 *
 * 端点: https://open.bigmodel.cn/api/paas/v4
 * 认证: Authorization: Bearer $ZHIPU_API_KEY
 */

import { OpenAICompatibleProvider } from './compatible.js';
import type { ProviderConfig } from '../types.js';
import { getProviderConfigLoader } from './config.js';

export function createZhipuProvider(config?: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  userId?: string;
}): OpenAICompatibleProvider {
  const provCfg = getProviderConfigLoader().getProvider('zhipu');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'ZHIPU_API_KEY',
    baseUrl: config?.baseUrl ?? provCfg?.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
    model: config?.model ?? provCfg?.defaultModel ?? 'glm-5.2',
    providerType: 'zhipu',
    maxOutputTokens: config?.maxOutputTokens,
    userId: config?.userId,
  });
}

export function createZhipuFromConfig(config: ProviderConfig): OpenAICompatibleProvider {
  return createZhipuProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    maxOutputTokens: config.maxOutputTokens,
    userId: config.userId,
  });
}
