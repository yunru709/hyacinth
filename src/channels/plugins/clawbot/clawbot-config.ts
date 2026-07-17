// ============================================================
// ClawBot 渠道配置类型
// ============================================================
//
// ClawBot 是微信官方 AI 助手连接插件，只支持单会话收发。
// 配置比飞书简单很多——没有群聊、DM 策略、访问控制列表等概念。
// ============================================================

/** ClawBot 渠道配置 */
export interface ClawbotChannelConfig {
  /** 是否启用 */
  enabled?: boolean;

  /** bot_token（可选，留空则首次自动走扫码授权流程） */
  botToken?: string;

  /** bot 用户 ID（ilink_bot_id，授权后自动填充，格式 xxx@im.bot） */
  botId?: string;

  /** 用户 ID（ilink_user_id，授权后自动填充，格式 xxx@im.wechat） */
  userId?: string;

  /** iLink API 根域名（默认 https://ilinkai.weixin.qq.com） */
  baseUrl?: string;

  /** 长轮询等待时长（秒），默认 28（服务端超时 35s，留 7s 缓冲） */
  pollTimeoutSec?: number;

  /** 轮询失败重试间隔（毫秒），默认 3000 */
  pollRetryIntervalMs?: number;

  /** 是否同步到 TUI 界面 */
  tuiSync?: boolean;

  /** 发送文本消息的最大长度（字符），默认 2000（微信实际限制保守值） */
  textChunkLimit?: number;

  /** 是否自动刷新 bot_token（提前 2 天告警提示重新扫码） */
  autoRefreshToken?: boolean;

  /** HTTP 请求超时（毫秒），默认 30_000 */
  httpTimeoutMs?: number;
}

/** 带默认值的完整配置 */
export function resolveClawbotConfig(raw: Partial<ClawbotChannelConfig>): ClawbotChannelConfig {
  return {
    enabled: raw.enabled ?? true,
    botToken: raw.botToken ?? '',
    botId: raw.botId ?? '',
    userId: raw.userId ?? '',
    baseUrl: raw.baseUrl ?? 'https://ilinkai.weixin.qq.com',
    pollTimeoutSec: raw.pollTimeoutSec ?? 28,
    pollRetryIntervalMs: raw.pollRetryIntervalMs ?? 3000,
    tuiSync: raw.tuiSync ?? false,
    textChunkLimit: raw.textChunkLimit ?? 2000,
    autoRefreshToken: raw.autoRefreshToken ?? true,
    httpTimeoutMs: raw.httpTimeoutMs ?? 30_000,
  };
}

/** 校验配置是否完备（启动时不强制要求 botToken，可以运行时扫码授权） */
export function validateClawbotConfig(config: ClawbotChannelConfig): string | null {
  return null; // 无必填项——即使没有 botToken，也可以在运行时走扫码授权
}
