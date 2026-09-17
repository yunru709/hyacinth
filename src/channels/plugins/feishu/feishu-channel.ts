// ============================================================
// FeishuChannel — 飞书渠道处理器
// ============================================================
//
// 实现 ChannelHandler 接口，提供飞书消息收发能力。
//
// 生命周期：
//   1. register → 注册到 ChannelManager
//   2. start() → 建立 WebSocket 连接，开始监听消息
//   3. 收到消息 → 解析 → 去重 → 访问控制 → 构造 ChannelMessageEvent
//   4. reply() → 将 Agent 回复发送回飞书
//   5. stop() → 断开 WebSocket 连接
// ============================================================

import os from 'node:os';

/**
 * 飞书渠道 sessionId 前缀（**插件自管**：常量定义在插件内，核心不反向依赖插件）。
 * 由 feishuChannelPlugin.autoRegister 开头无条件登记 —— 该钩子与 enabled 无关，
 * 因此即使飞书渠道被禁用，存量 feishu_xxx 会话仍能推断出渠道归属。
 */
export const FEISHU_SESSION_PREFIX = 'feishu_';
import type {
  ChannelHandler,
  ChannelEvent,
  ChannelReply,
  ChannelTarget,
  ChannelConfig,
  ChannelStatus,
  ChannelMessageEvent,
  ChannelOutputHandler,
} from '../../interface.js';
import {
  resolveFeishuConfig,
  validateFeishuConfig,
  type FeishuChannelConfig,
} from './feishu-config.js';
import { FeishuTransport } from './feishu-transport.js';
import {
  parseFeishuMessageEvent,
  FeishuDedupeStore,
  checkDmAccess,
  checkGroupAccess,
  type FeishuMessageEvent,
  type FeishuMessageContext,
} from './feishu-event.js';
import { sendText, sendCard, sendImage, getSenderInfo } from './feishu-send.js';
import { FeishuMessageQueue } from './feishu-message-queue.js';
import path from 'node:path';
import fs from 'node:fs/promises';

// ── 日志 ──

interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

function defaultLogger(): Logger {
  return {
    info: (msg) => process.stderr.write(`[feishu] ${msg}\n`),
    error: (msg) => process.stderr.write(`[feishu] ${msg}\n`),
  };
}

// ── FeishuChannel ──

export class FeishuChannel implements ChannelHandler {
  readonly id = 'feishu';
  readonly name = 'Feishu (飞书)';
  readonly description = '飞书企业即时通讯渠道，支持 WebSocket 长连接收发消息';
  readonly pluginId = undefined;
  /** sessionId 前缀（引用 src/session-channel.ts 内置前缀常量，勿写字面量） */
  readonly sessionPrefix = FEISHU_SESSION_PREFIX;
  /** 能力声明：飞书是持久消息渠道（用户离线也能收到）→ 定时任务最后兜底 + 陪伴推送目标；优先级 10 最高 */
  readonly loopCapabilities = { persistent: true, fallbackPriority: 10 } as const;

  private status: ChannelStatus = 'registered';
  private config!: FeishuChannelConfig;
  private transport: FeishuTransport | null = null;
  private eventHandler: ((event: ChannelEvent) => Promise<void>) | null = null;
  private logger: Logger = defaultLogger();
  private dedupeStore = new FeishuDedupeStore();
  private messageQueue = new FeishuMessageQueue();

  // ── 传输态（仅回答「往哪个 chat 发」，不创建/不解析/不持久化会话） ──
  /** sessionId → 回复目标绑定（reply()/sendProactiveMessage() 据此找目标） */
  private sessionMap = new Map<string, {
    chatId: string;
    messageId: string;
    threadId?: string;
    chatType: string;
    isGroup: boolean;
  }>();
  /** 主动推送兜底目标（最近活跃会话；重启后经 feishu_default 恢复 chatId） */
  private lastActiveSessionId: string | null = null;

  // chatId 持久化（重启后无需等待用户先发消息即可主动推送）
  // 家目录（与其余 ~/.agent 配置一致）：渠道状态不应跟 process.cwd() 走
  private persistChatIdFile = path.join(os.homedir(), '.agent', 'feishu_chat.json');

  // tuiSync 回调（由 start() 的 config 注入）
  private onUserMessage: ((label: string, content: string) => void) | null = null;
  private onAgentReply: ((content: string) => void) | null = null;
  // 是否使用流式卡片（server 模式）
  private useStreamingCard = false;

  // tenant access token 缓存（避免每次下载图片都请求新 token）
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  /** 当前进行中的流式卡片（onLoopEnd 收尾/中止用） */
  private currentStreaming: { finish(): Promise<void>; abort(msg: string): Promise<void> } | null = null;

  async start(config: ChannelConfig): Promise<void> {
    this.status = 'starting';

    // 解析配置
    this.config = resolveFeishuConfig(config as unknown as Partial<FeishuChannelConfig>);

    // tuiSync 回调（由 start() 的 config 注入）
    this.onUserMessage = (config as Record<string, unknown>).onUserMessage as ((label: string, content: string) => void) | null ?? null;
    this.onAgentReply = (config as Record<string, unknown>).onAgentReply as ((content: string) => void) | null ?? null;
    this.useStreamingCard = (config as Record<string, unknown>).useStreamingCard as boolean ?? false;

    // 校验配置
    const validationError = validateFeishuConfig(this.config);
    if (validationError) {
      this.status = 'error';
      throw new Error(validationError);
    }

    // 注：会话解析/恢复/持久化已收归内核 SessionService（manager.startChannel →
    // bindChannel）。本渠道只保留**传输态**持久化（chatId/isGroup），
    // 供重启后无需等待用户先发消息即可主动推送。

    this.logger.info(`starting with appId=${this.config.appId.slice(0, 8)}...`);

    // 创建传输层
    this.transport = new FeishuTransport(this.config, this.logger);

    // 注册消息处理
    this.transport.onMessage(async (event: FeishuMessageEvent) => {
      await this.handleRawMessage(event);
    });

    // 初始化消息队列：processFn 调用 eventHandler（ChannelManager.onEvent 回调）
    this.messageQueue.setProcessFn(async (event: ChannelEvent) => {
      if (this.eventHandler) {
        await this.eventHandler(event);
      } else {
        this.logger.error('no eventHandler registered, queued message dropped');
      }
    });

    // 启动 WebSocket 连接（阻塞等待连接建立）
    try {
      await this.transport.start();
      this.status = 'active';
      this.logger.info('channel started, WebSocket connected');

      // 恢复持久化的 chatId（重启后无需等待用户先发消息即可主动推送）
      await this.restoreFeishuTransport();
    } catch (err) {
      this.status = 'error';
      this.logger.error(`transport start failed: ${String(err instanceof Error ? err.message : err)}`);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('stopping channel...');
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }
    this.sessionMap.clear();
    this.messageQueue.clear();
    this.status = 'stopped';
    this.logger.info('channel stopped');
  }

  onEvent(handler: (event: ChannelEvent) => Promise<void>): void {
    this.eventHandler = handler;
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const session = this.sessionMap.get(sessionId);
    if (!session) {
      this.logger.error(`reply failed: session ${sessionId} not found`);
      return;
    }

    const to = session.isGroup ? `chat:${session.chatId}` : `user:${session.chatId}`;

    try {
      const text = reply.content;

      if (reply.metadata?.card) {
        // 卡片消息
        await sendCard(this.config, {
          to,
          card: reply.metadata.card as Record<string, unknown>,
          replyToMessageId: session.messageId,
          replyInThread: !!session.threadId,
        });
      } else {
        // 文本消息
        await sendText(this.config, {
          to,
          text,
          replyToMessageId: session.messageId,
          replyInThread: !!session.threadId,
        });
      }

      // TUI 同步（回复文本）
      if (this.config.tuiSync && this.onAgentReply && text) {
        this.onAgentReply(text);
      }
    } catch (err) {
      this.logger.error(`reply failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  // ================================================================
  // send() — 跨渠道借用能力入口
  // ================================================================
  //
  // 设计意图：
  //   每个渠道有自己独特的发送能力（飞书能发卡片和图片、微信能发文件、
  //   TUI 只能显示文本）。send() 将这些能力暴露给外部，使得其他渠道
  //   的 Agent 可以借用本渠道的能力发送消息。
  //
  // 行为保证（"纯借用"语义）：
  //   - 不创建 session —— 消息是一次性的，没有对应的 AgentLoop
  //   - 不写 conversation.jsonl —— 不污染任何渠道的对话历史
  //   - 不影响 ChannelHandler 内部状态 —— sessionMap、消息队列等完全不变
  //   - 被借用方对"谁借的"完全无感 —— 不需要知道调用方是哪个渠道
  //
  // 调用链：
  //   Agent → send_channel_message 工具 → MessageDispatcher
  //        → ChannelManager.get('feishu') → FeishuChannel.send()
  //
  // 支持的消息类型（按优先级）：
  //   1. 卡片消息（content.metadata.card 存在时）—— 飞书交互式卡片
  //   2. 文本消息（默认）—— Post 格式，支持 Markdown 子集
  //   3. 图片消息（content.images 存在时）—— 先上传获取 image_key，再发送
  //      ↑ 图片在文本/卡片之后独立发送，失败不影响前面的消息
  //
  // 注意：
  //   - 图片上传需要 tenant_access_token（通过 getTenantAccessToken 获取）
  //   - 每条图片独立上传 + 发送，某张失败不阻塞其他图片
  //   - 图片 base64 直接传给飞书 API，不在本地落盘
  // ================================================================
  async send(target: ChannelTarget, content: ChannelReply): Promise<string> {
    if (this.status !== 'active') return '飞书渠道未连接，无法发送';

    const config = this.config;
    // 飞书 SDK 的 receive_id_type 由 ID 前缀推断（ou_→open_id, oc_→chat_id）
    // sendText/sendCard/sendImage 内部调用 resolveSendTarget 自动处理
    const to = target.type === 'chat' ? `chat:${target.id}` : `user:${target.id}`;

    try {
      // ① 主消息：卡片优先，否则文本
      if (content.metadata?.card) {
        await sendCard(config, { to, card: content.metadata.card as Record<string, unknown> });
      } else {
        await sendText(config, { to, text: content.content });
      }

      // ② 图片：在文本/卡片之后独立发送
      // 飞书的图片消息和文本消息是两条独立的消息，不支持图文混排
      if (content.images && content.images.length > 0) {
        const token = await this.getTenantAccessToken();
        if (token) {
          for (const img of content.images) {
            try {
              // 飞书图片发送两步：上传拿 image_key → 调用 im.message.create 发送
              const imageKey = await this.uploadImage(token, img.data);
              await sendImage(config, { to, imageKey });
            } catch {
              // 某张图片失败不阻塞其他图片和整体流程
            }
          }
        }
      }

      return `已通过飞书发送到 ${to}`;
    } catch (err) {
      return `飞书发送失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ================================================================
  // uploadImage() — 飞书图片上传
  // ================================================================
  //
  // 飞书发送图片必须先上传到飞书服务器获取 image_key，
  // 再用 image_key 调用 im.message.create（msg_type='image'）发送。
  //
  // API: POST https://open.feishu.cn/open-apis/im/v1/images
  // 参数（multipart/form-data）: image_type='message'（消息用图），image=文件
  // 返回: { code: 0, data: { image_key: 'img_xxx' } }
  //
  // 注意：
  //   - 必须用 multipart/form-data 上传（base64 JSON body 已被飞书废弃，
  //     会返回 234011 "Can't recognize image format"）
  //   - token 由调用方传入（来自 getTenantAccessToken 的缓存结果）
  //   - 飞书 image_key 有时效性（约 2 小时），不持久化缓存
  // ================================================================
  private async uploadImage(token: string, base64Data: string, mediaType?: string): Promise<string> {
    const domain = this.resolveApiBase();
    // base64 → Buffer → Blob
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const mime = mediaType && mediaType.includes('/') ? mediaType : 'image/png';
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'png';

    // 飞书上传图片必须用 multipart/form-data（base64 JSON body 方式已被飞书废弃，
    // 返回 234011 "Can't recognize image format"）。Content-Type 由 fetch 根据
    // FormData 自动生成（含 boundary），不要手动设置。
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', new Blob([imageBuffer], { type: mime }), `camera.${ext}`);

    const resp = await fetch(`${domain}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form,
    });
    const json = await resp.json() as { code?: number; msg?: string; data?: { image_key?: string } };
    if (json.code !== 0 || !json.data?.image_key) {
      throw new Error(`飞书图片上传失败: code=${json.code} ${json.msg ?? ''}`);
    }
    return json.data.image_key;
  }

  /** 解析飞书 API 基础域名：'feishu'/'lark' 短标识 → 完整 URL（配置里存的是短标识） */
  private resolveApiBase(): string {
    const d = this.config?.domain;
    if (d === 'lark') return 'https://open.larksuite.com';
    if (!d || d === 'feishu') return 'https://open.feishu.cn';
    return d;
  }

  /** 获取 tenant access token（缓存，提前 60s 刷新，token 有效期 2h） */
  private async getTenantAccessToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }
    try {
      const domain = this.resolveApiBase();
      const resp = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      });
      const json = await resp.json() as { tenant_access_token?: string; expire?: number };
      if (json.tenant_access_token) {
        this.cachedToken = json.tenant_access_token;
        this.tokenExpiresAt = Date.now() + (json.expire ?? 7200) * 1000;
        return this.cachedToken;
      }
    } catch { /* 获取失败不阻塞 */ }
    return null;
  }

  /**
   * 主动推送消息到飞书（非回复模式）。
   * 用于定时任务等场景，此时没有 incoming message，需要根据 sessionId 查找 chatId 再发送。
   */
  async sendProactiveMessage(sessionId: string, text: string): Promise<void> {
    let session = this.sessionMap.get(sessionId);
    // 降级：sessionId 可能是 "companion" 等非飞书 ID，或内核恢复的会话尚未有消息往来
    // → 回落最近活跃会话目标（重启后 = feishu_default 恢复的持久化 chatId）
    if (!session && this.lastActiveSessionId && this.lastActiveSessionId !== sessionId) {
      session = this.sessionMap.get(this.lastActiveSessionId);
      if (session) {
        this.logger.info(`sendProactiveMessage: ${sessionId.slice(0, 20)}... not in sessionMap, fallback to lastActiveSessionId`);
      }
    }
    if (!session) {
      this.logger.error(`sendProactiveMessage: session ${sessionId} not found in sessionMap — has a message been received from this chat yet?`);
      return;
    }
    const to = session.isGroup ? `chat:${session.chatId}` : `user:${session.chatId}`;
    try {
      await sendText(this.config, { to, text });
      this.logger.info(`proactive message sent to ${sessionId.slice(0, 20)}...`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const ctx = (err as any)?.feishuContext as Record<string, unknown> | undefined;
      const resp = (err as any)?.feishuResponse as unknown;
      const parts = [`sendProactiveMessage failed: ${detail}`];
      if (ctx) parts.push(`context: ${JSON.stringify(ctx)}`);
      if (resp) parts.push(`response: ${JSON.stringify(resp)}`);
      this.logger.error(parts.join(' | '));
    }
  }

  // ── chatId 持久化（传输态：只存 {chatId, isGroup}，会话映射归内核 SessionService） ──
  // 个人助手场景：默认只服务一个用户，chatId 一般不会变。
  // 有新消息时自动更新，确保更换账号后也能无缝切换。

  private async persistFeishuTransport(sessionId: string): Promise<void> {
    const session = this.sessionMap.get(sessionId);
    if (!session) return;
    try {
      const data = {
        chatId: session.chatId,
        isGroup: session.isGroup,
      };
      await fs.mkdir(path.dirname(this.persistChatIdFile), { recursive: true });
      await fs.writeFile(this.persistChatIdFile, JSON.stringify(data), 'utf-8');
    } catch { /* 写入失败不阻塞 */ }
  }

  /** 恢复持久化的传输态：仅 {chatId, isGroup} → sessionMap['feishu_default'] 兜底目标 */
  private async restoreFeishuTransport(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistChatIdFile, 'utf-8');
      const data = JSON.parse(raw);
      if (data.chatId) {
        this.sessionMap.set('feishu_default', {
          chatId: data.chatId,
          messageId: '',
          chatType: data.isGroup ? 'group' : 'dm',
          isGroup: !!data.isGroup,
        });
        this.lastActiveSessionId = 'feishu_default';
        this.logger.info(`restored chatId from persistence: ${data.chatId}`);
      }
    } catch { /* 文件不存在或格式错误，首次启动正常 */ }
  }

  // ── 内核编排钩子（替代旧 handleMessage/handleTaskNotification 全链路） ──

  /**
   * 会话绑定通知：内核解析出 sessionId 后回调。
   * 渠道只做**传输态**记录（回复目标绑定 + 兜底目标 + chatId 持久化），不决定 sessionId。
   */
  async onSessionBound(sessionId: string, event: ChannelMessageEvent): Promise<void> {
    const meta = event.metadata ?? {};
    this.sessionMap.set(sessionId, {
      chatId: meta.chatId as string,
      messageId: meta.messageId as string,
      threadId: meta.threadId as string | undefined,
      chatType: (meta.chatType as string) ?? (meta.isGroup ? 'group' : 'dm'),
      isGroup: !!meta.isGroup,
    });
    this.lastActiveSessionId = sessionId;
    // 持久化 chatId（重启后无需等待新消息即可主动推送）
    await this.persistFeishuTransport(sessionId);
  }

  /**
   * 自定义输出处理器（server 模式）：流式卡片逐 token 渲染。
   * TUI 模式返回 undefined → 内核回落到 collectHandler + reply() 一次性发送。
   */
  async createOutputHandler(
    _sessionId: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChannelOutputHandler | undefined> {
    if (!this.useStreamingCard) return undefined;

    // Import FeishuStreamingCard lazily to avoid circular deps
    const { FeishuStreamingCard } = await import('./feishu-streaming.js');

    const isGroup = metadata?.isGroup as boolean | undefined;
    const chatId = metadata?.chatId as string | undefined;
    const to = isGroup ? `chat:${chatId}` : `user:${metadata?.senderOpenId ?? ''}`;
    const replyToMessageId = metadata?.messageId as string | undefined;
    const replyInThread = !!metadata?.threadId;

    const streaming = new FeishuStreamingCard(this.config, {
      replyToMessageId,
      replyInThread,
      updateIntervalMs: 1000,
      onError: (err) => this.logger.error(`streaming error: ${err.message}`),
    });
    this.currentStreaming = streaming;

    try {
      await streaming.start(to);
    } catch (err) {
      this.logger.error(`streaming start failed: ${String(err instanceof Error ? err.message : err)}`);
    }

    return {
      // 每个新 turn 清空之前累积的文本，只保留最后一轮的输出
      onTurnStart: () => { streaming.resetBuffer(); },
      onText: (text) => { streaming.append(text); },
      onStatus: (msg, level) => { this.logger.info(`[feishu-agent] ${level}: ${msg}`); },
    };
  }

  /** loop.run 开始前：TUI 同步用户消息 */
  async onLoopStart(event: ChannelMessageEvent, _sessionId: string): Promise<void> {
    if (this.config.tuiSync && this.onUserMessage) {
      const label = (event.metadata?.senderName as string) || event.userId.slice(0, 8);
      this.onUserMessage(label, event.content);
    }
  }

  /** loop.run 结束后（成功 → 卡片收尾；异常 → 卡片中止） */
  async onLoopEnd(_sessionId: string, error?: unknown): Promise<void> {
    const streaming = this.currentStreaming;
    this.currentStreaming = null;
    if (!streaming) return;
    try {
      if (error) {
        await streaming.abort(String(error instanceof Error ? error.message : String(error)));
      } else {
        await streaming.finish();
      }
    } catch { /* 卡片收尾失败不阻塞 */ }
  }

  // ── ChannelHandler: updateConfig ──

  async updateConfig(newConfig: Record<string, unknown>): Promise<void> {
    const newFeishuConfig = newConfig as Partial<FeishuChannelConfig>;
    const needRestart = !this.config ||
      this.config.appId !== newFeishuConfig.appId ||
      this.config.appSecret !== newFeishuConfig.appSecret ||
      this.config.domain !== newFeishuConfig.domain;

    if (needRestart && newFeishuConfig.appId && newFeishuConfig.appSecret) {
      this.config = resolveFeishuConfig(newFeishuConfig);
      // The gateway will call manager.restart() which calls stop() + start()
    } else {
      // Just update non-connection config
      this.config = resolveFeishuConfig(newFeishuConfig);
    }
  }

  // ── 原始消息处理（WebSocket 收到 → 去重 → 访问控制 → 构造 ChannelMessageEvent）──

  private async handleRawMessage(event: FeishuMessageEvent): Promise<void> {
    const ctx = parseFeishuMessageEvent(event);

    // 消息去重：优先使用 message.message_id（消息级唯一ID），回退到 header.event_id
    // WebSocket 重连后同一消息的 event_id 会变，message_id 不变，所以 message_id 才是可靠的去重键
    const dedupeKey = ctx.messageId || event._eventId;
    if (!dedupeKey) {
      this.logger.error('no dedupe key available, dropping message');
      return;
    }
    if (!this.dedupeStore.check(dedupeKey)) {
      this.logger.info(`duplicate message detected, skipping: ${dedupeKey.slice(0, 12)}...`);
      return;
    }

    this.logger.info(
      `received: ${ctx.messageId.slice(0, 8)}... from=${ctx.senderOpenId.slice(0, 8)}... ` +
      `chat=${ctx.chatId.slice(0, 8)}... type=${ctx.chatType}`,
    );

    // ── 访问控制 ──

    if (ctx.isGroup) {
      // 群聊：检查群组访问权限
      if (!checkGroupAccess(ctx.chatId, this.config.groupPolicy!, this.config.groupAllowFrom!)) {
        this.logger.info(`group ${ctx.chatId} not in allowlist, skipping`);
        return;
      }

      // 群聊：检查是否需要 @提及
      if (this.config.requireMention && !ctx.mentionedBot) {
        this.logger.info(`bot not mentioned in group ${ctx.chatId}, skipping`);
        return;
      }
    } else {
      // DM：检查 DM 访问权限
      if (!checkDmAccess(ctx.senderOpenId, this.config.dmPolicy!, this.config.allowFrom!)) {
        this.logger.info(`sender ${ctx.senderOpenId} not in DM allowlist, skipping`);
        return;
      }
    }

    // ── 发送者名称 + 图片下载（互不依赖）──

    // 发送者名称：fire-and-forget，不阻塞消息入队（仅用于 TUI 显示标签）
    if (this.config.resolveSenderNames && ctx.senderOpenId) {
      getSenderInfo(this.config, ctx.senderOpenId)
        .then(info => { if (info?.name) ctx.senderName = info.name; })
        .catch(() => {});
    }

    // 图片下载
    let images: ChannelMessageEvent['images'];
    if (ctx.imageKey && ctx.messageId && this.config?.appId && this.config?.appSecret) {
      try {
        const token = await this.getTenantAccessToken();
        if (token) {
          const domain = this.resolveApiBase();
          const resp = await fetch(
            `${domain}/open-apis/im/v1/messages/${ctx.messageId}/resources/${ctx.imageKey}?type=image`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            const contentType = resp.headers.get('content-type') || 'image/png';
            images = [{ data: buf.toString('base64'), media_type: contentType }];
          }
        }
      } catch { /* 下载失败不影响文本消息 */ }
    }

    // ── 构造 ChannelMessageEvent ──
    // 会话主控权归内核（SessionService 单点解析）：渠道只提供**身份**（identity + metadata），
    // **不解析/不决定 sessionId**（conversationKey 映射已迁入内核 identityMap）。
    const channelEvent: ChannelEvent = {
      type: 'message',
      userId: ctx.senderOpenId,
      content: ctx.content,
      channel: this.id,
      identity: {
        userId: ctx.senderOpenId,
        chatId: ctx.chatId,
        threadId: ctx.threadId,
        isGroup: ctx.isGroup,
      },
      images,
      metadata: {
        messageId: ctx.messageId,
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        isGroup: ctx.isGroup,
        senderOpenId: ctx.senderOpenId,
        senderName: ctx.senderName,
        contentType: ctx.contentType,
        threadId: ctx.threadId,
        parentId: ctx.parentId,
        rootId: ctx.rootId,
        mentionedBot: ctx.mentionedBot,
      },
    };

    // 通过消息队列转发给 ChannelManager（入队即返回，ACK 立即发出）。
    // 队列键用 chatId（传输态串行化：同一会话的消息按序处理，避免 conversation.jsonl 交叉写入）。
    this.messageQueue.enqueue(ctx.chatId, channelEvent);
  }
}