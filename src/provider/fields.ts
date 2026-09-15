/**
 * Provider 字段翻译层 —— 私有字段通用化
 *
 * 背景：DeepSeek 的 user_id（KVCache 隔离）是 OpenAI 兼容 schema 上的厂商私有字段，
 * 此前在 compatible.ts 里硬编码发给所有 OpenAI 兼容厂商（含 OpenAI 原生）。本模块把
 * 这类字段抽成「通用语义字段」（ProviderFields），再按协议翻译成各厂商的 wire 字段名：
 *
 *   openai      → user_id（DeepSeek 语义：缓存隔离；兼容厂商普遍接受顶层字段）
 *   openaiUser  → user（OpenAI 原生标准字段：滥用检测 / 按用户限流）
 *   anthropic   → metadata.user_id（Anthropic Messages API 标准字段）
 *   responses   → user（Responses API，预留）
 *
 * 新增通用字段只需两步：ProviderFields 加字段 + PROTOCOL_FIELD_MAP 加一行映射。
 * 某厂商端点字段名不同（如 OpenAI 兼容端点用标准 user），用 fieldMapOverride 覆盖。
 */
import { DEFAULT_USER_ID } from './user-id.js';

/** 通用字段（跨厂商语义，与 wire 格式解耦） */
export interface ProviderFields {
  /** 用户/会话隔离键（openai→user_id / openaiUser→user / anthropic→metadata.user_id） */
  userId?: string;
  /** 思考模式（thinking 走各实现专属路径，此处仅为字段注册） */
  thinking?: boolean;
  /** 推理强度 */
  reasoningEffort?: string;
  /** 单次请求最大输出 token 数 */
  maxOutputTokens?: number;
  /** 采样温度 */
  temperature?: number;
  /** Top-P */
  topP?: number;
  /** 频率惩罚 */
  frequencyPenalty?: number;
  /** 存在惩罚 */
  presencePenalty?: number;
}

/** 采样参数子集（激活配置与模型目录通用） */
export type ProviderSampling = Pick<
  ProviderFields,
  'temperature' | 'topP' | 'frequencyPenalty' | 'presencePenalty'
>;

/** 兼容协议种类 */
export type ProtocolKind = 'openai' | 'openaiUser' | 'anthropic' | 'responses';

/**
 * 协议 → wire 字段名映射。
 * 'metadata.' 前缀表示嵌套到请求 metadata 对象（Anthropic 语义）。
 * 未列出的通用字段（thinking 等）由各实现专属路径处理。
 */
export const PROTOCOL_FIELD_MAP: Record<ProtocolKind, Partial<Record<keyof ProviderFields, string>>> = {
  openai: {
    userId: 'user_id',
    maxOutputTokens: 'max_tokens',
    temperature: 'temperature',
    topP: 'top_p',
    frequencyPenalty: 'frequency_penalty',
    presencePenalty: 'presence_penalty',
  },
  openaiUser: {
    userId: 'user',
    maxOutputTokens: 'max_tokens',
    temperature: 'temperature',
    topP: 'top_p',
    frequencyPenalty: 'frequency_penalty',
    presencePenalty: 'presence_penalty',
  },
  anthropic: {
    userId: 'metadata.user_id',
    maxOutputTokens: 'max_tokens',
    temperature: 'temperature',
    topP: 'top_p',
  },
  responses: {
    userId: 'user',
  },
};

/** 翻译结果：顶层字段 + 嵌套 metadata（anthropic 的 metadata.user_id） */
export interface TranslatedFields {
  topLevel: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * 翻译：通用字段 → wire 字段。
 *
 * - openai / openaiUser：userId 缺省时兜底 DEFAULT_USER_ID（与旧行为一致，始终发隔离字段）
 * - anthropic / responses：仅显式设置才发（保守，避免向不支持厂商发未知字段）
 * - fieldMapOverride：per-provider wire 名覆盖（JSON 声明厂商 meta.fieldMap 传入）
 */
export function translateFields(
  kind: ProtocolKind,
  fields?: ProviderFields,
  fieldMapOverride?: Partial<Record<keyof ProviderFields, string>>,
): TranslatedFields {
  const topLevel: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};

  if (!fields) return { topLevel };

  const effective: ProviderFields = { ...fields };
  if ((kind === 'openai' || kind === 'openaiUser') && effective.userId === undefined) {
    effective.userId = DEFAULT_USER_ID;
  }

  const map = { ...PROTOCOL_FIELD_MAP[kind], ...fieldMapOverride };
  for (const [key, value] of Object.entries(effective)) {
    if (value === undefined || value === null) continue;
    const wire = map[key as keyof ProviderFields];
    if (!wire) continue; // 未映射的字段（thinking 等）由各实现专属路径处理
    if (wire.startsWith('metadata.')) {
      metadata[wire.slice('metadata.'.length)] = value;
    } else {
      topLevel[wire] = value;
    }
  }

  return {
    topLevel,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}
