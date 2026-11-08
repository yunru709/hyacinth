// ============================================================
// QqChannel — QQ 渠道处理器（NapCat / OneBot v11）
// ============================================================
//
// 实现 ChannelHandler 接口。生命周期：
//   1. register → ChannelManager 注册
//   2. start()  → 连 WS（3001）、拉 self_id
//   3. 收到消息 → 去重 → 白名单 → 构造 ChannelMessageEvent → 内核编排
//   4. reply()  → 调 HTTP send_private_msg / send_group_msg
//   5. stop()   → 断 WS
//
// ⚠️ 安全默认（2026-11-08 与孑遗确认）：
//   本渠道**先只服务号主本人**。allowFrom 为空 = 谁都不理（不是"对所有人开放"）。
//   群聊必须 groupAllowFrom 显式列群号，且默认要求 @我。
//   理由见 qq-config.ts 头注释（按人分权要改内核，先用白名单把"谁能说话"关死）。
//
// ⚠️ 会话主控权归内核：本渠道只提供 identity（userId/chatId/isGroup），
//   **不决定 sessionId**（与飞书/clawbot 一致，见 interface.ts 的 ChannelMessageEvent.sessionId 注释）。
// ============================================================

import type {
  ChannelHandler,
  ChannelEvent,
  ChannelMessageEvent,
  ChannelReply,
  ChannelTarget,
  ChannelConfig,
  ChannelStatus,
} from '../../interface.js';
import {
  resolveQqConfig,
  validateQqConfig,
  isAllowedUser,
  isAllowedGroup,
  type QqChannelConfig,
} from './qq-config.js';
import {
  QqClient,
  extractText,
  isMentioned,
  chunkText,
  type Ob11AnyEvent,
  type Ob11MessageEvent,
} from './qq-client.js';

/** sessionId 前缀（插件自管；由 index.ts 的 autoRegister 无条件登记） */
export const QQ_SESSION_PREFIX = 'qq_';

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

function defaultLogger(): Logger {
  return {
    info: (msg) => process.stderr.write(`[qq] ${msg}\n`),
    warn: (msg) => process.stderr.write(`[qq] ${msg}\n`),
    error: (msg) => process.stderr.write(`[qq] ${msg}\n`),
  };
}

/** sessionId → 回复目标（传输态，不持久化；重启后靠内核恢复会话 + 首条消息重建） */
interface ReplyTarget {
  userId: number;
  groupId?: number;
  isGroup: boolean;
}

export class QqChannel implements ChannelHandler {
  readonly id = 'qq';
  readonly name = 'QQ';
  readonly description = 'QQ 渠道（NapCat / OneBot v11），支持私聊与群聊 @ 回复';
  readonly pluginId = undefined;
  readonly sessionPrefix = QQ_SESSION_PREFIX;
  /** 持久消息渠道：用户离线后上线仍能收到 → 参与定时任务兜底。优先级低于飞书(10)、高于 clawbot(5) */
  readonly loopCapabilities = { persistent: true, fallbackPriority: 7 } as const;

  private status: ChannelStatus = 'registered';
  private config!: Required<QqChannelConfig>;
  private client: QqClient | null = null;
  private logger: Logger = defaultLogger();
  private eventHandler: ((event: ChannelEvent) => Promise<void>) | null = null;

  /** sessionId → 回复目标 */
  private sessionMap = new Map<string, ReplyTarget>();
  /** 最近活跃会话（主动推送兜底） */
  private lastActiveSessionId: string | null = null;

  /** 实际 self_id（优先配置，其次 get_login_info） */
  private selfId = '';

  /** 消息去重（message_id 级） */
  private seenMessageIds = new Set<number>();
  private static MAX_SEEN = 500;

  /** 每会话串行队列（防 conversation.jsonl 交叉写入） */
  private queues = new Map<string, ChannelEvent[]>();
  private processing = new Set<string>();
  /** 内核给的 sessionId 由 onSessionBound 回调告知，入队时先按 identity 键排队 */
  private pendingKeyOf = new Map<ChannelEvent, string>();

  async start(config: ChannelConfig): Promise<void> {
    this.status = 'starting';
    this.config = resolveQqConfig(config as unknown as Partial<QqChannelConfig>);

    const err = validateQqConfig(this.config);
    if (err) {
      this.status = 'error';
      throw new Error(err);
    }

    if (!this.config.enabled) {
      // 未启用：只注册不连接（保证 /qq 类命令可达，且不产生无谓连接）
      this.status = 'active';
      this.logger.info('QQ channel registered but not enabled (enabled=false)');
      return;
    }

    this.client = new QqClient(
      {
        httpUrl: this.config.httpUrl,
        wsUrl: this.config.wsUrl,
        accessToken: this.config.accessToken,
        httpTimeoutMs: this.config.httpTimeoutMs,
        reconnectIntervalMs: this.config.reconnectIntervalMs,
      },
      this.logger,
    );

    // 先确认后端在线 + 取 self_id（连不上就明确报错，别静默半死）
    try {
      const info = await this.client.getLoginInfo();
      this.selfId = this.config.selfId ? String(this.config.selfId) : String(info.user_id);
      this.logger.info(`backend ok: ${info.nickname} (${info.user_id}), selfId=${this.selfId}`);
    } catch (e) {
      this.status = 'error';
      throw new Error(`QQ 后端不可达（${this.config.httpUrl}）：${e instanceof Error ? e.message : String(e)}。请确认 NapCat 在跑。`);
    }

    this.client.setHandlers({
      onEvent: (ev) => this.handleOb11Event(ev),
      onConnected: () => { this.status = 'active'; this.logger.info('channel active'); },
      onDisconnected: () => { if (this.status === 'active') this.status = 'starting'; },
    });
    this.client.connect();

    this.status = 'active';
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.client = null;
    this.sessionMap.clear();
    this.queues.clear();
    this.processing.clear();
    this.seenMessageIds.clear();
    this.status = 'stopped';
    this.logger.info('channel stopped');
  }

  onEvent(handler: (event: ChannelEvent) => Promise<void>): void {
    this.eventHandler = handler;
  }

  /** 内核解析出 sessionId 后回调：记录回复目标 */
  onSessionBound(sessionId: string, event: ChannelMessageEvent): void {
    const meta = event.metadata ?? {};
    const userId = Number(meta.userId ?? event.userId);
    const groupId = meta.groupId !== undefined ? Number(meta.groupId) : undefined;
    const isGroup = Boolean(meta.isGroup);
    this.sessionMap.set(sessionId, { userId, groupId, isGroup });
    this.lastActiveSessionId = sessionId;
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    if (!this.client) {
      this.logger.error('reply failed: client not initialized');
      return;
    }
    const target = this.sessionMap.get(sessionId);
    if (!target) {
      this.logger.error(`reply failed: session ${sessionId} not bound`);
      return;
    }
    const text = reply.content?.trim();
    if (!text) return;

    try {
      const chunks = chunkText(text, this.config.textChunkLimit);
      for (const c of chunks) {
        if (target.isGroup && target.groupId !== undefined) {
          await this.client.sendGroup(target.groupId, c);
        } else {
          await this.client.sendPrivate(target.userId, c);
        }
      }
    } catch (e) {
      this.logger.error(`reply failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  // ── 主动发送（跨渠道借用 + 定时任务推送） ────────────────
  async sendProactiveMessage(sessionId: string, text: string): Promise<void> {
    if (!this.client) {
      this.logger.error('sendProactiveMessage: client not ready');
      return;
    }
    let target = this.sessionMap.get(sessionId);
    if (!target && this.lastActiveSessionId) {
      target = this.sessionMap.get(this.lastActiveSessionId);
    }
    if (!target) {
      this.logger.error(`sendProactiveMessage: session ${sessionId} unknown (no message received yet)`);
      return;
    }
    for (const c of chunkText(text, this.config.textChunkLimit)) {
      if (target.isGroup && target.groupId !== undefined) await this.client.sendGroup(target.groupId, c);
      else await this.client.sendPrivate(target.userId, c);
    }
  }

  /** 跨渠道借用：type=user → id 是 QQ 号；type=chat → id 是群号 */
  async send(target: ChannelTarget, content: ChannelReply): Promise<string> {
    if (!this.client) return 'QQ 渠道未就绪';
    const text = content.content?.trim();
    if (!text) return '内容为空';
    try {
      for (const c of chunkText(text, this.config.textChunkLimit)) {
        if (target.type === 'chat') await this.client.sendGroup(target.id, c);
        else await this.client.sendPrivate(target.id, c);
      }
      return `已发送到 QQ ${target.type === 'chat' ? '群' : '用户'} ${target.id}`;
    } catch (e) {
      return `发送失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── 事件处理 ──────────────────────────────────────────────

  private handleOb11Event(ev: Ob11AnyEvent): void {
    if (ev.post_type !== 'message') {
      // notice/request 暂不处理（好友申请由独立监听脚本负责，见 F:\WSL\scripts\friend-listener.py）
      return;
    }
    this.handleMessage(ev as Ob11MessageEvent);
  }

  private handleMessage(ev: Ob11MessageEvent): void {
    // ① 去重
    if (this.seenMessageIds.has(ev.message_id)) {
      this.logger.info(`dedup: message_id=${ev.message_id} already handled`);
      return;
    }
    this.seenMessageIds.add(ev.message_id);
    if (this.seenMessageIds.size > QqChannel.MAX_SEEN) {
      // 简单截断（Set 保序，删最早的）
      const first = this.seenMessageIds.values().next().value;
      if (first !== undefined) this.seenMessageIds.delete(first);
    }

    // ② 忽略自己发的消息（reportSelfMessage 关掉也可能回灌）
    if (String(ev.user_id) === this.selfId) return;

    const isGroup = ev.message_type === 'group';

    // ③ 访问控制：私聊白名单 / 群白名单 + @我
    if (isGroup) {
      if (!ev.group_id || !isAllowedGroup(this.config, ev.group_id)) {
        this.logger.info(`group ${ev.group_id} not allowed, skip`);
        return;
      }
      if (this.config.requireMention && !isMentioned(ev, this.selfId)) {
        return; // 群里没 @我 → 静默（不刷日志，太吵）
      }
    } else {
      if (!isAllowedUser(this.config, ev.user_id)) {
        this.logger.warn(`private message from ${ev.user_id} not in allowFrom, dropped`);
        return;
      }
    }

    // ④ 提取文本
    const content = extractText(ev);
    if (!content) return;

    const nickname = ev.sender?.card || ev.sender?.nickname || '';
    this.logger.info(`recv ${isGroup ? `group:${ev.group_id}` : `user:${ev.user_id}`} ${nickname}: ${content.slice(0, 40)}`);

    // ⑤ 构造事件（只给 identity，不决定 sessionId）
    const channelEvent: ChannelMessageEvent = {
      type: 'message',
      userId: String(ev.user_id),
      content,
      channel: this.id,
      identity: {
        userId: String(ev.user_id),
        chatId: isGroup ? String(ev.group_id) : String(ev.user_id),
        isGroup,
      },
      metadata: {
        messageId: String(ev.message_id),
        userId: ev.user_id,
        groupId: ev.group_id,
        isGroup,
        nickname,
        senderName: nickname,
      },
    };

    // ⑥ 入队（按 chat 键串行）
    const queueKey = isGroup ? `g:${ev.group_id}` : `u:${ev.user_id}`;
    this.pendingKeyOf.set(channelEvent, queueKey);
    this.enqueue(queueKey, channelEvent);
  }

  private enqueue(key: string, event: ChannelEvent): void {
    let q = this.queues.get(key);
    if (!q) { q = []; this.queues.set(key, q); }
    q.push(event);
    this.processNext(key);
  }

  private processNext(key: string): void {
    if (this.processing.has(key)) return;
    const q = this.queues.get(key);
    if (!q || q.length === 0) return;
    if (!this.eventHandler) {
      this.logger.error('no eventHandler registered, message dropped');
      q.length = 0;
      return;
    }
    const event = q.shift()!;
    this.processing.add(key);
    void this.eventHandler(event)
      .catch((e) => this.logger.error(`process error: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.processing.delete(key);
        this.pendingKeyOf.delete(event);
        const rest = this.queues.get(key);
        if (rest && rest.length > 0) this.processNext(key);
        else this.queues.delete(key);
      });
  }
}

export function createQqChannel(): QqChannel {
  return new QqChannel();
}
