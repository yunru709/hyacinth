// ============================================================
// QQ 渠道配置类型（NapCat / OneBot v11）
// ============================================================
//
// 设计取舍（2026-11-08，与孑遗确认）：
//   本渠道**先只服务号主本人**（allowFrom 白名单），不做按人分权的工具管制。
//   原因：按发送者切换工具集需要把 sender 一路透传到 loop/stage（loop.ts 目前
//   没有任何 senderId 入口，identity 在 SessionService 层就被消费掉了），
//   属于「给内核加新维度」的改动。先用白名单把「谁能跟我说话」这道闸关死，
//   权限问题自然消失；等真的需要「我旁听陌生人对话」时再做内核改造。
//
// 后端：NapCat（Linux QQ 的 hook 注入），对外暴露 OneBot v11。
//   HTTP  :3000  发消息（send_private_msg / send_group_msg）
//   WS    :3001  收事件（post_type=message / notice / request）
// ============================================================

/** QQ 渠道配置 */
export interface QqChannelConfig {
  /** 是否启用 */
  enabled?: boolean;

  /** OneBot HTTP API 地址（默认 http://127.0.0.1:3000） */
  httpUrl?: string;

  /** OneBot WebSocket 事件地址（默认 ws://127.0.0.1:3001） */
  wsUrl?: string;

  /** OneBot 访问令牌（NapCat 默认空串） */
  accessToken?: string;

  /**
   * 私聊白名单（QQ 号）。
   * **空数组 = 拒绝所有人**（安全默认，写错配置不会变成"对全世界开放"）。
   */
  allowFrom?: Array<number | string>;

  /** 群聊白名单（群号）。空 = 不进任何群 */
  groupAllowFrom?: Array<number | string>;

  /** 群聊中是否需要 @我 才回复（默认 true） */
  requireMention?: boolean;

  /** 自己的 QQ 号（用于识别群聊里的 @我；留空则自动从 get_login_info 取） */
  selfId?: number | string;

  /** 是否同步到 TUI 界面 */
  tuiSync?: boolean;

  /** 单条消息最大长度（字符），默认 4000（QQ 实际更宽松，保守取飞书同级） */
  textChunkLimit?: number;

  /** HTTP 请求超时（毫秒），默认 15_000 */
  httpTimeoutMs?: number;

  /** WS 断线重连间隔（毫秒），默认 3_000 */
  reconnectIntervalMs?: number;
}

/** 带默认值的完整配置 */
/**
 * ⚠️ 注意 allowFrom 的默认值语义：`[]` = 谁都不理。
 * 微信/飞书那种 dmPolicy:'open' 的宽松默认在这里是危险的——
 * 一个填错的配置不该让全世界都能指挥我的工具。宁可不回。
 */
export function resolveQqConfig(raw: Partial<QqChannelConfig>): Required<QqChannelConfig> {
  return {
    enabled: raw.enabled ?? false,
    httpUrl: raw.httpUrl ?? 'http://127.0.0.1:3000',
    wsUrl: raw.wsUrl ?? 'ws://127.0.0.1:3001',
    accessToken: raw.accessToken ?? '',
    allowFrom: raw.allowFrom ?? [],
    groupAllowFrom: raw.groupAllowFrom ?? [],
    requireMention: raw.requireMention ?? true,
    selfId: raw.selfId ?? '',
    tuiSync: raw.tuiSync ?? false,
    textChunkLimit: raw.textChunkLimit ?? 4000,
    httpTimeoutMs: raw.httpTimeoutMs ?? 15_000,
    reconnectIntervalMs: raw.reconnectIntervalMs ?? 3_000,
  };
}

/**
 * 校验配置。
 * 只有「启用了但白名单是空的」算错误——那确实是配置事故（以为能收消息，其实全被拦）。
 * 未启用时白名单空是正常的。
 */
export function validateQqConfig(config: Required<QqChannelConfig>): string | null {
  if (!config.enabled) return null;
  if (config.allowFrom.length === 0) {
    return 'QQ 渠道已启用但 allowFrom 为空：所有消息都会被拒绝。请填入允许的 QQ 号。';
  }
  if (!config.httpUrl) return 'qq config: httpUrl is required';
  if (!config.wsUrl) return 'qq config: wsUrl is required';
  return null;
}

/** 判断某 QQ 号是否在白名单内 */
export function isAllowedUser(config: Required<QqChannelConfig>, userId: number | string): boolean {
  const id = String(userId);
  return config.allowFrom.some((u) => String(u) === id);
}

/** 判断某群号是否在白名单内 */
export function isAllowedGroup(config: Required<QqChannelConfig>, groupId: number | string): boolean {
  const id = String(groupId);
  return config.groupAllowFrom.some((g) => String(g) === id);
}
