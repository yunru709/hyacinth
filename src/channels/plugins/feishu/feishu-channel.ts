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

import type {
  ChannelHandler,
  ChannelEvent,
  ChannelReply,
  ChannelConfig,
  ChannelStatus,
  ChannelMessageEvent,
  AgentFactory,
  ReplyFn,
  ChannelOutputHandler,
  ChannelSessionRunner,
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
import { sendText, sendCard, getSenderInfo } from './feishu-send.js';
import { ChannelSessionPool, createCollectHandler } from './feishu-session.js';
import { FeishuMessageQueue } from './feishu-message-queue.js';

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

  private status: ChannelStatus = 'registered';
  private config!: FeishuChannelConfig;
  private transport: FeishuTransport | null = null;
  private eventHandler: ((event: ChannelEvent) => Promise<void>) | null = null;
  private logger: Logger = defaultLogger();
  private dedupeStore = new FeishuDedupeStore();
  private messageQueue = new FeishuMessageQueue();

  // 会话映射：sessionId → { chatId, messageId, threadId, chatType }
  private sessionMap = new Map<string, {
    chatId: string;
    messageId: string;
    threadId?: string;
    chatType: string;
    isGroup: boolean;
  }>();

  // TUI/Server 模式共享
  private sessionPool = new ChannelSessionPool();
  private agentFactory: AgentFactory | null = null;

  // tuiSync 回调（由 start() 的 config 注入）
  private onUserMessage: ((label: string, content: string) => void) | null = null;
  private onAgentReply: ((content: string) => void) | null = null;
  // 是否使用流式卡片（server 模式）
  private useStreamingCard = false;

  // LRU loop cache for server mode
  private loopCache = new Map<string, ChannelSessionRunner>();
  private loopAccessOrder: string[] = [];
  private static MAX_LOOP_CACHE = 50;

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
    this.sessionPool.clear();
    this.messageQueue.clear();
    this.loopCache.clear();
    this.loopAccessOrder = [];
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
    } catch (err) {
      this.logger.error(`reply failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  // ── ChannelHandler: handleMessage ──

  async handleMessage(
    event: ChannelMessageEvent,
    replyFn: ReplyFn,
    agentFactory: AgentFactory,
  ): Promise<void> {
    if (!this.config) return;

    const chatId = (event.metadata?.chatId as string) ?? '';
    const senderOpenId = (event.metadata?.senderOpenId as string) ?? event.userId;

    // tuiSync 回调
    if (this.config.tuiSync && this.onUserMessage) {
      const label = (event.metadata?.senderName as string) || event.userId.slice(0, 8);
      this.onUserMessage(label, event.content);
    }

    try {
      const isShared = this.config.sessionMode === 'shared';

      if (this.useStreamingCard) {
        // server 模式：使用流式卡片
        await this.handleWithStreamingCard(event, replyFn, agentFactory, chatId, senderOpenId);
      } else {
        // TUI 模式：使用 collectHandler 收集回复
        await this.handleWithCollectHandler(event, replyFn, agentFactory, chatId, senderOpenId, isShared);
      }
    } catch (err) {
      this.logger.error(`handleMessage error: ${String(err instanceof Error ? err.message : err)}`);
      try {
        await replyFn({ content: `处理出错: ${err instanceof Error ? err.message : String(err)}` });
      } catch { /* ignore */ }
    }
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

  // ── TUI 模式：collectHandler 收集回复 ──

  private async handleWithCollectHandler(
    event: ChannelMessageEvent,
    replyFn: ReplyFn,
    agentFactory: AgentFactory,
    chatId: string,
    senderOpenId: string,
    isShared: boolean,
  ): Promise<void> {
    const entry = await this.sessionPool.getOrCreate(
      this.config,
      chatId,
      senderOpenId,
      async () => {
        const handler = createCollectHandler();
        const { loop } = await agentFactory.createAgent({
          outputHandler: handler,
          sessionId: event.sessionId,
        });
        return { loop, collectHandler: handler };
      },
    );

    entry.collectHandler.reset();
    if (event.images?.length) (entry.loop as any).channelImages = event.images;
    await entry.loop.run(event.content);
    const response = entry.collectHandler.getResponse();

    if (response) {
      await replyFn({ content: response });
    }

    if (this.config.tuiSync && this.onAgentReply && response) {
      this.onAgentReply(response);
    }
  }

  // ── Server 模式：流式卡片输出 ──

  private async handleWithStreamingCard(
    event: ChannelMessageEvent,
    replyFn: ReplyFn,
    agentFactory: AgentFactory,
    chatId: string,
    senderOpenId: string,
  ): Promise<void> {
    // Import FeishuStreamingCard lazily to avoid circular deps
    const { FeishuStreamingCard } = await import('./feishu-streaming.js');

    const isGroup = event.metadata?.isGroup as boolean | undefined;
    const to = isGroup ? `chat:${chatId}` : `user:${event.userId}`;
    const replyToMessageId = event.metadata?.messageId as string | undefined;
    const replyInThread = !!event.metadata?.threadId;

    const loop = await this.getOrCreateLoop(event.sessionId, agentFactory);

    const streaming = new FeishuStreamingCard(this.config, {
      replyToMessageId,
      replyInThread,
      updateIntervalMs: 1000,
      onError: (err) => this.logger.error(`streaming error: ${err.message}`),
    });

    try {
      await streaming.start(to);
    } catch (err) {
      this.logger.error(`streaming start failed: ${String(err instanceof Error ? err.message : err)}`);
    }

    const outputHandler: ChannelOutputHandler = {
      onText: (text) => { streaming.append(text); },
      onStatus: (msg, level) => { this.logger.info(`[feishu-agent] ${level}: ${msg}`); },
    };

    loop.setOutputHandler(outputHandler);

    try {
      if (event.images?.length) (loop as any).channelImages = event.images;
      await loop.run(event.content);
      await streaming.finish();
    } catch (err) {
      await streaming.abort(String(err instanceof Error ? err.message : String(err)));
      await replyFn({ content: `处理出错: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      loop.setOutputHandler({ onText: () => {}, onStatus: () => {} });
    }
  }

  // ── LRU loop cache for server mode ──

  private async getOrCreateLoop(sessionId: string, agentFactory: AgentFactory): Promise<ChannelSessionRunner> {
    const cached = this.loopCache.get(sessionId);
    if (cached) {
      // LRU: move to end
      const idx = this.loopAccessOrder.indexOf(sessionId);
      if (idx >= 0) {
        this.loopAccessOrder.splice(idx, 1);
        this.loopAccessOrder.push(sessionId);
      }
      return cached;
    }

    const { loop } = await agentFactory.createAgent({
      sessionId,
      outputHandler: { onText: () => {}, onStatus: () => {} },
    });

    // LRU eviction
    if (this.loopAccessOrder.length >= FeishuChannel.MAX_LOOP_CACHE) {
      const oldest = this.loopAccessOrder.shift()!;
      this.loopCache.delete(oldest);
    }

    this.loopCache.set(sessionId, loop);
    this.loopAccessOrder.push(sessionId);
    return loop;
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

    // ── 解析发送者名称（可选） ──

    if (this.config.resolveSenderNames && ctx.senderOpenId) {
      try {
        const info = await getSenderInfo(this.config, ctx.senderOpenId);
        if (info?.name) {
          ctx.senderName = info.name;
        }
      } catch {
        // 忽略获取名称失败
      }
    }

    // ── 构造 sessionId（使用 _ 而非 :，: 在 Windows 上不可用于文件夹名） ──

    const sessionId = ctx.isGroup
      ? `feishu_group_${ctx.chatId}${ctx.threadId ? `_thread_${ctx.threadId}` : ''}`
      : `feishu_dm_${ctx.senderOpenId}`;

    // 记录会话信息
    this.sessionMap.set(sessionId, {
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      threadId: ctx.threadId,
      chatType: ctx.chatType,
      isGroup: ctx.isGroup,
    });

    // ── 下载图片（message_type: 'image'） ──
    let images: ChannelMessageEvent['images'];
    if (ctx.imageKey && ctx.messageId && this.config?.appId && this.config?.appSecret) {
      try {
        // 获取 tenant access token
        const tokenResp = await fetch(
          'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
          },
        );
        const tokenJson = await tokenResp.json() as { tenant_access_token?: string };
        const token = tokenJson.tenant_access_token;
        if (token) {
          const resp = await fetch(
            `https://open.feishu.cn/open-apis/im/v1/messages/${ctx.messageId}/resources/${ctx.imageKey}?type=image`,
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
    const channelEvent: ChannelEvent = {
      type: 'message',
      sessionId,
      userId: ctx.senderOpenId,
      content: ctx.content,
      channel: this.id,
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

    // 通过消息队列转发给 ChannelManager（入队即返回，ACK 立即发出）
    this.messageQueue.enqueue(sessionId, channelEvent);
  }
}