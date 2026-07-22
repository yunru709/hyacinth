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
  ChannelTarget,
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
import { sendText, sendCard, sendImage, getSenderInfo } from './feishu-send.js';
import { ChannelSessionPool, createCollectHandler } from './feishu-session.js';
import { FeishuMessageQueue } from './feishu-message-queue.js';
import { generateSessionId } from '../../../memory/session.js';
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

  // conversationKey → sessionId，同一对话复用同一 session 目录
  private conversationToSession = new Map<string, string>();

  // TUI/Server 模式共享
  private sessionPool = new ChannelSessionPool();
  private agentFactory: AgentFactory | null = null;
  // 最近使用的 loop 引用（用于定时任务主动推送时获取 loop）
  private lastUsedLoop: ChannelSessionRunner | null = null;
  private lastUsedSessionId: string | null = null;

  // chatId 持久化（重启后无需等待用户先发消息即可主动推送）
  private persistChatIdFile = path.join(process.cwd(), '.agent', 'feishu_chat.json');

  // tuiSync 回调（由 start() 的 config 注入）
  private onUserMessage: ((label: string, content: string) => void) | null = null;
  private onAgentReply: ((content: string) => void) | null = null;
  // 是否使用流式卡片（server 模式）
  private useStreamingCard = false;

  // LRU loop cache for server mode
  private loopCache = new Map<string, ChannelSessionRunner>();
  private loopAccessOrder: string[] = [];
  private static MAX_LOOP_CACHE = 50;
  // sessionId → loop 直接映射（供 handleTaskNotification 查找正确的 loop）
  private sessionLoopMap = new Map<string, ChannelSessionRunner>();

  // tenant access token 缓存（避免每次下载图片都请求新 token）
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

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

    // 注册到全局 channelLoop 注册表（供定时任务路由到飞书渠道）
    const registry = (globalThis as any).__channelLoopRegistry as Map<string, {
      notifyTaskFired(name: string, sessionId?: string): Promise<void>;
      sendProactiveMessage?(sessionId: string, text: string): Promise<void>;
    }> | undefined;
    if (registry) {
      registry.set('feishu', {
        notifyTaskFired: async (name: string, sessionId?: string) => {
          await this.handleTaskNotification(name, sessionId);
        },
        sendProactiveMessage: async (sessionId: string, text: string) => {
          await this.sendProactiveMessage(sessionId, text);
        },
      });
      this.logger.info('registered in channelLoop registry for scheduled task routing');
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

      // 恢复持久化的 chatId（重启后无需等待用户先发消息即可主动推送）
      await this.restoreFeishuState();
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
    this.conversationToSession.clear();
    this.sessionPool.clear();
    this.messageQueue.clear();
    this.loopCache.clear();
    this.sessionLoopMap.clear();
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
  // 参数: image_type='message'（消息用图，非头像），image=base64（不含 data:xxx;base64, 前缀）
  // 返回: { code: 0, data: { image_key: 'img_xxx' } }
  //
  // 注意：
  //   - token 由调用方传入（来自 getTenantAccessToken 的缓存结果）
  //   - mediaType 参数保留供未来扩展（如格式校验），当前仅透传 base64
  //   - 飞书 image_key 有时效性（约 2 小时），不持久化缓存
  // ================================================================
  private async uploadImage(token: string, base64Data: string, _mediaType?: string): Promise<string> {
    const domain = this.config?.domain ?? 'https://open.feishu.cn';
    const resp = await fetch(`${domain}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_type: 'message',
        image: base64Data,
      }),
    });
    const json = await resp.json() as { code?: number; data?: { image_key?: string } };
    if (json.code !== 0 || !json.data?.image_key) {
      throw new Error(`飞书图片上传失败: code=${json.code}`);
    }
    return json.data.image_key;
  }

  /** 获取 tenant access token（缓存，提前 60s 刷新，token 有效期 2h） */
  private async getTenantAccessToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }
    try {
      const domain = this.config?.domain ?? 'https://open.feishu.cn';
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
    // 降级：陪伴模式下 sessionId 可能是 "companion" 等非飞书 ID
    if (!session && this.lastUsedSessionId && this.lastUsedSessionId !== sessionId) {
      session = this.sessionMap.get(this.lastUsedSessionId);
      if (session) {
        this.logger.info(`sendProactiveMessage: ${sessionId.slice(0, 20)}... not in sessionMap, fallback to lastUsedSessionId`);
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

  // ── chatId 持久化 ──────────────────────────────────────────────
  // 个人助手场景：默认只服务一个用户，chatId 一般不会变。
  // 有新消息时自动更新，确保更换账号后也能无缝切换。
  // 同时持久化 conversation→session 映射，确保重启后复用同一 session 目录。

  private async persistFeishuState(sessionId: string): Promise<void> {
    const session = this.sessionMap.get(sessionId);
    if (!session) return;
    try {
      const sessions: Record<string, string> = {};
      for (const [key, sid] of this.conversationToSession) {
        sessions[key] = sid;
      }
      const data = {
        chatId: session.chatId,
        isGroup: session.isGroup,
        sessions,
      };
      await fs.mkdir(path.dirname(this.persistChatIdFile), { recursive: true });
      await fs.writeFile(this.persistChatIdFile, JSON.stringify(data), 'utf-8');
    } catch { /* 写入失败不阻塞 */ }
  }

  private async restoreFeishuState(): Promise<void> {
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
        this.lastUsedSessionId = 'feishu_default';
        this.logger.info(`restored chatId from persistence: ${data.chatId}`);
      }
      // 恢复 conversation→session 映射，确保同一对话重启后复用同一 session 目录
      if (data.sessions && typeof data.sessions === 'object') {
        for (const [key, sid] of Object.entries(data.sessions)) {
          if (typeof sid === 'string') {
            this.conversationToSession.set(key, sid);
          }
        }
        this.logger.info(`restored ${this.conversationToSession.size} session mapping(s)`);
      }
    } catch { /* 文件不存在或格式错误，首次启动正常 */ }
  }

  /**
   * 处理定时任务通知：运行 Agent 并将结果主动推送到飞书。
   * @param taskName 定时任务名称
   * @param sessionId 创建任务时的 session，用于确定回复目标
   */
  async handleTaskNotification(taskName: string, sessionId?: string): Promise<void> {
    const effectiveSessionId = sessionId ?? this.lastUsedSessionId;
    if (!effectiveSessionId) {
      this.logger.error('handleTaskNotification: no sessionId available — cannot send proactive message');
      return;
    }

    // 按 sessionId 查找正确的 loop（多会话场景下不能用 lastUsedLoop）
    let loop: ChannelSessionRunner | null = this.sessionLoopMap.get(effectiveSessionId) ?? null;

    // fallback: 尝试 loopCache（server 模式 LRU）
    if (!loop) {
      loop = this.loopCache.get(effectiveSessionId) ?? null;
    }

    // 最后兜底：使用 lastUsedLoop（可能是新 session 尚未有消息往来）
    if (!loop) {
      loop = this.lastUsedLoop;
      if (loop) {
        this.logger.info(`handleTaskNotification: using lastUsedLoop as fallback for session ${effectiveSessionId.slice(0, 20)}...`);
      }
    }

    if (!loop) {
      this.logger.error('handleTaskNotification: no loop available — no message has been processed yet');
      return;
    }

    const prompt = `[Scheduled Task Triggered]\nYour scheduled task "${taskName}" has just been triggered via Feishu. Execute it now and respond naturally. If this was a one-shot task, it has completed — no need to reschedule.`;

    // 临时收集输出
    const texts: string[] = [];
    const collectHandler: ChannelOutputHandler = {
      onTurnStart: () => { texts.length = 0; },
      onText: (text) => { texts.push(text); },
      onStatus: (msg, level) => { this.logger.info(`[feishu-task] ${level}: ${msg}`); },
    };

    loop.setOutputHandler(collectHandler);
    try {
      await loop.run(prompt);
      const response = texts.join('').trim();
      if (response) {
        // 修正发送目标：创建任务时的 sessionId 可能来自其他渠道（如 TUI），
        // 不在飞书的 sessionMap 中。此时降级使用 lastUsedSessionId。
        const sendSessionId = this.sessionMap.has(effectiveSessionId)
          ? effectiveSessionId
          : (this.lastUsedSessionId ?? effectiveSessionId);
        if (sendSessionId !== effectiveSessionId) {
          this.logger.info(
            `handleTaskNotification: session ${effectiveSessionId.slice(0, 20)}... not in sessionMap, ` +
            `fallback send to ${sendSessionId.slice(0, 20)}...`
          );
        }
        await this.sendProactiveMessage(sendSessionId, response);
      } else {
        this.logger.info(`handleTaskNotification: task "${taskName}" produced no text output`);
      }
    } catch (err) {
      this.logger.error(`handleTaskNotification error: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      // 恢复空操作 outputHandler
      loop.setOutputHandler({ onText: () => {}, onStatus: () => {} });
    }
  }

  // ── ChannelHandler: handleMessage ──

  async handleMessage(
    event: ChannelMessageEvent,
    replyFn: ReplyFn,
    agentFactory: AgentFactory,
  ): Promise<void> {
    if (!this.config) return;

    // 存储 agentFactory 引用（供 handleTaskNotification 使用）
    this.agentFactory = agentFactory;

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
          channel: 'feishu',
        });
        return { loop, collectHandler: handler };
      },
    );

    entry.collectHandler.reset();
    if (event.images?.length) (entry.loop as any).channelImages = event.images;

    // 存储引用供定时任务主动推送使用
    const sessionLoop = entry.loop as unknown as ChannelSessionRunner;
    this.lastUsedLoop = sessionLoop;
    this.lastUsedSessionId = event.sessionId;
    this.sessionLoopMap.set(event.sessionId, sessionLoop);

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
      // 每个新 turn 清空之前累积的文本，只保留最后一轮的输出
      onTurnStart: () => { streaming.resetBuffer(); },
      onText: (text) => { streaming.append(text); },
      onStatus: (msg, level) => { this.logger.info(`[feishu-agent] ${level}: ${msg}`); },
    };

    loop.setOutputHandler(outputHandler);

    // 存储引用供定时任务主动推送使用
    this.lastUsedLoop = loop;
    this.lastUsedSessionId = event.sessionId;
    this.sessionLoopMap.set(event.sessionId, loop);

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
      channel: 'feishu',
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

    // ── 构造 sessionId（纯同步，不依赖网络）──
    const conversationKey = ctx.isGroup
      ? `feishu_group_${ctx.chatId}${ctx.threadId ? `_thread_${ctx.threadId}` : ''}`
      : `feishu_dm_${ctx.senderOpenId}`;

    let sessionId = this.conversationToSession.get(conversationKey);
    if (!sessionId) {
      sessionId = generateSessionId('feishu');
      this.conversationToSession.set(conversationKey, sessionId);
    }

    // 记录会话信息
    this.sessionMap.set(sessionId, {
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      threadId: ctx.threadId,
      chatType: ctx.chatType,
      isGroup: ctx.isGroup,
    });

    // 持久化 chatId（重启后无需等待新消息即可主动推送）
    this.persistFeishuState(sessionId);

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
          const domain = this.config?.domain ?? 'https://open.feishu.cn';
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