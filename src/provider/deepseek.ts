import { OpenAICompatibleProvider } from './compatible.js';
import type { ProviderConfig } from '../types.js';
import type { ProviderFields, ProviderSampling } from './fields.js';
import { getProviderConfigLoader } from './config.js';

/**
 * DeepSeek Provider — 基于 OpenAI 兼容 API。
 *
 * DeepSeek 的 API 使用 OpenAI Chat Completions 兼容格式。
 * Endpoint: https://api.deepseek.com/v1
 *
 * 支持模型：
 *   - deepseek-v4-flash-0731 (V4 Flash 0731，1M上下文，推荐)
 *   - deepseek-v4-pro (V4 Pro，1M上下文)
 *   - deepseek-v4-flash (旧版，已退役，replacedBy deepseek-v4-flash-0731)
 */
export function createDeepSeekProvider(config?: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  /** DeepSeek KVCache 隔离 ID。不同角色应使用不同的 userId。 */
  userId?: string;
  /** 通用字段（userId 归一入口） */
  fields?: ProviderFields;
  /** 采样参数（temperature/topP/penalties） */
  sampling?: ProviderSampling;
  /** 通用字段 → wire 字段名覆盖（映射数据化：providers.json 可配置） */
  fieldMap?: Partial<Record<keyof ProviderFields, string>>;
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
    fields: config?.fields,
    sampling: config?.sampling,
    fieldMap: config?.fieldMap,
  });
}

/** 从 ProviderConfig 创建（fieldMap 第二参：工厂层解析的厂商级 wire 覆盖） */
export function createDeepSeekFromConfig(
  config: ProviderConfig,
  fieldMap?: Partial<Record<keyof ProviderFields, string>>,
): OpenAICompatibleProvider {
  return createDeepSeekProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    maxOutputTokens: config.maxOutputTokens,
    userId: config.userId,
    fields: config.fields,
    sampling: config.sampling,
    fieldMap,
  });
}