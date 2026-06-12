// ============================================================
// Feishu 渠道配置类型
// ============================================================

/** 连接模式 */
export type FeishuConnectionMode = 'websocket'; // 后续可扩展 'webhook'

/** DM 策略 */
export type FeishuDmPolicy = 'open' | 'allowlist' | 'disabled';

/** 群组策略 */
export type FeishuGroupPolicy = 'open' | 'allowlist' | 'disabled';

/** 飞书渠道配置 */
export interface FeishuChannelConfig {
  /** 是否启用 */
  enabled?: boolean;

  /** 飞书应用 App ID */
  appId: string;
  /** 飞书应用 App Secret */
  appSecret: string;

  /** 连接模式（默认 websocket） */
  connectionMode?: FeishuConnectionMode;

  /** API 域名：feishu（国内飞书）/ lark（国际） */
  domain?: 'feishu' | 'lark';

  /** HTTP 请求超时（毫秒），默认 30_000 */
  httpTimeoutMs?: number;

  // ── 访问控制 ──

  /** DM 策略（默认 'allowlist'） */
  dmPolicy?: FeishuDmPolicy;
  /**
   * DM 允许列表（open_id 列表）
   * - dmPolicy='allowlist' 时只允许列表内用户私聊
   * - 包含 '*' 表示允许所有人
   */
  allowFrom?: string[];

  /** 群组策略（默认 'allowlist'） */
  groupPolicy?: FeishuGroupPolicy;
  /**
   * 群组允许列表（chat_id 列表）
   * - groupPolicy='allowlist' 时只允许列表内群组接收消息
   */
  groupAllowFrom?: string[];

  /** 群聊中是否需要 @提及 才回复（默认 true） */
  requireMention?: boolean;

  /** 是否解析发送者显示名称（默认 true，会消耗 API 配额） */
  resolveSenderNames?: boolean;

  // ── 消息路由 ──

  /** 飞书消息是否同步到 TUI 界面（默认 false） */
  tuiSync?: boolean;
  /** session 复用策略：shared=共用主loop, per_chat=按聊天, per_user=按用户（默认 'per_user'） */
  sessionMode?: 'shared' | 'per_chat' | 'per_user';

  // ── 消息限制 ──

  /** 消息历史条数限制（群聊），默认 10 */
  historyLimit?: number;

  /** 发送文本消息的最大长度（字符），默认 4000 */
  textChunkLimit?: number;
}

/** 带默认值的完整配置 */
export function resolveFeishuConfig(raw: Partial<FeishuChannelConfig>): FeishuChannelConfig {
  const appId = raw.appId ?? '';
  const appSecret = raw.appSecret ?? '';

  return {
    enabled: raw.enabled ?? true,
    appId,
    appSecret,
    connectionMode: raw.connectionMode ?? 'websocket',
    domain: raw.domain ?? 'feishu',
    httpTimeoutMs: raw.httpTimeoutMs ?? 30_000,
    dmPolicy: raw.dmPolicy ?? 'allowlist',
    allowFrom: raw.allowFrom ?? [],
    groupPolicy: raw.groupPolicy ?? 'allowlist',
    groupAllowFrom: raw.groupAllowFrom ?? [],
    requireMention: raw.requireMention ?? true,
    resolveSenderNames: raw.resolveSenderNames ?? true,
    tuiSync: raw.tuiSync ?? false,
    sessionMode: raw.sessionMode ?? 'per_user',
    historyLimit: raw.historyLimit ?? 10,
    textChunkLimit: raw.textChunkLimit ?? 4000,
  };
}

/** 校验配置是否完备 */
export function validateFeishuConfig(config: FeishuChannelConfig): string | null {
  if (!config.appId) return 'Feishu config: appId is required';
  if (!config.appSecret) return 'Feishu config: appSecret is required';
  return null;
}