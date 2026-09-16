// ============================================================
// ClawbotChannel — 微信 ClawBot 渠道处理器
// ============================================================
//
// 实现 ChannelHandler 接口，通过 HTTP 长轮询收发微信 ClawBot 消息。
//
// 与飞书渠道的关键差异：
//   - HTTP 长轮询（非 WebSocket）
//   - 无 SDK，裸 HTTP JSON 调用
//   - 单会话（无群聊/多用户/多 session）
//   - context_token 机制（回复消息必须携带对上一条消息的 context_token）
//   - get_updates_buf opaque blob 管理
//   - 消息分片（2000 字符阈值）
//   - 二维码授权（非 appId/appSecret）
//
// 生命周期：
//   1. register → 注册到 ChannelManager
//   2. start() → 授权 → 启动长轮询监听
//   3. 收到消息 → 过滤 state ≠ FINISH → 入队 → 构造 ChannelMessageEvent
//   4. handleMessage() → 创建/复用 loop → run → 收集回复 → 分片发送
//   5. stop() → 停止长轮询 → 清理资源
// ============================================================

/**
 * 微信 ClawBot 渠道 sessionId 前缀（**插件自管**）。
 *
 * 修复的正是"产得出来、认不出来"缺口：生产侧 generateSessionId('clawbot') 一直
 * 造得出 clawbot_xxx，但注册表里从来没有 clawbot_，导致会话归属永远推断不出、
 * 渠道隔离失效。现由插件在 autoRegister 开头无条件登记（与 enabled 无关）。
 */
export const CLAWBOT_SESSION_PREFIX = 'clawbot_';
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
  resolveClawbotConfig,
  type ClawbotChannelConfig,
} from './clawbot-config.js';
import { ClawbotClient, ClawbotAPIError, type ClawbotIncomingMessage } from './clawbot-client.js';
import { ClawbotAuthManager, type AuthCallbacks } from './clawbot-auth.js';
import { ClawbotMessageQueue } from './clawbot-message-queue.js';
import { createCollectHandler, type CollectHandler } from './clawbot-session.js';
import { generateSessionId } from '../../../memory/session.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// ── 日志 ──────────────────────────────────────────────────────

interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

function defaultLogger(): Logger {
  return {
    info: (msg) => process.stderr.write(`[clawbot] ${msg}\n`),
    error: (msg) => process.stderr.write(`[clawbot] ${msg}\n`),
  };
}

// ── Session 信息 ──────────────────────────────────────────────

interface SessionInfo {
  /** 用户 ID，格式 xxx@im.wechat */
  userId: string;
  /** 最近一条消息的 context_token（回复时必填） */
  contextToken: string;
}

// ── ClawbotChannel ────────────────────────────────────────────

export class ClawbotChannel implements ChannelHandler {
  readonly id = 'clawbot';
  readonly name = '微信 ClawBot';
  readonly description = '微信官方 AI 助手连接插件，支持 HTTP 长轮询收发消息';
  readonly pluginId = undefined;
  /** sessionId 前缀（引用 src/session-channel.ts 内置前缀常量，勿写字面量） */
  readonly sessionPrefix = CLAWBOT_SESSION_PREFIX;

  private status: ChannelStatus = 'registered';
  private config!: ClawbotChannelConfig;
  private logger: Logger = defaultLogger();

  // ── 核心依赖 ──────────────────────────────────────────────────
  private client: ClawbotClient | null = null;
  private auth: ClawbotAuthManager | null = null;
  private messageQueue = new ClawbotMessageQueue();
  private agentFactory: AgentFactory | null = null;

  // ── 长轮询状态 ────────────────────────────────────────────────
  private polling = false;
  private pollAbortController: AbortController | null = null;
  /** getUpdates 的 opaque blob，首次空字符串，后续回传上次返回值 */
  private getUpdatesBuf = '';

  // ── 会话状态 ──────────────────────────────────────────────────
  /** 单会话信息（ClawBot 只有一个会话） */
  private sessionInfo: SessionInfo | null = null;
  /** sessionId → SessionInfo 映射（兼容多 session 接口） */
  private sessionMap = new Map<string, SessionInfo>();

  // ── AgentLoop 引用 ───────────────────────────────────────────
  private loop: ChannelSessionRunner | null = null;
  private collectHandler: CollectHandler | null = null;
  private sessionId: string | null = null;

  // ── typing 状态 ──────────────────────────────────────────────
  private typingTicket = '';
  private typingConfigFetched = false;

  // ── TUI 同步 ─────────────────────────────────────────────────
  private onUserMessage: ((label: string, content: string) => void) | null = null;
  private onAgentReply: ((content: string) => void) | null = null;

  // ── Session 持久化 ───────────────────────────────────────────
  private persistSessionFile = path.join(process.cwd(), '.agent', 'clawbot_session.json');

  // ── 定时器 ───────────────────────────────────────────────────
  /** 每日 token 过期检查定时器 */
  private dailyCheckTimer: ReturnType<typeof setInterval> | null = null;

  // ═══════════════════════════════════════════════════════════
  // ChannelHandler 接口实现
  // ═══════════════════════════════════════════════════════════

  async start(config: ChannelConfig): Promise<void> {
    this.status = 'starting';

    this.config = resolveClawbotConfig(config as unknown as Partial<ClawbotChannelConfig>);

    // TUI 同步回调
    this.onUserMessage = (config as Record<string, unknown>).onUserMessage as ((label: string, content: string) => void) | null ?? null;
    this.onAgentReply = (config as Record<string, unknown>).onAgentReply as ((content: string) => void) | null ?? null;

    const baseUrl = this.config.baseUrl!;

    // ── 授权回调（将二维码和中转状态输出到 TUI / 控制台） ──
    const authCallbacks: AuthCallbacks = {
      onQRCode: (qrUrl, _qrcode) => {
        this.logger.info(`QR Code URL: ${qrUrl}`);
        if (this.onUserMessage) {
          this.onUserMessage('ClawBot', `🔐 请扫描二维码授权登录微信 ClawBot：\n${qrUrl}`);
        }
      },
      onStatusChange: (status) => {
        this.logger.info(`Auth: ${status}`);
      },
    };

    this.auth = new ClawbotAuthManager(baseUrl, this.config.httpTimeoutMs!, authCallbacks);

    // ── 未启用（autoConnect: false）：备好授权通道，但不连接 ──
    // 渠道此时仍会被注册/启动 —— 唯有如此 `/clawbot login` 才可达（插件侧始终注册
    // 并通过本字段传达用户的 enabled）。此处刻意不恢复缓存 token、不建立长轮询，
    // 用户配置 enabled:false 的意图得以保留。
    // 而用户显式执行 `/clawbot login` 授权成功后，triggerAuth() 会走 activateClient()
    // 正式接入 —— 显式动作覆盖被动默认，登录即用，无需再改配置重启。
    if ((config as Record<string, unknown>).autoConnect === false) {
      this.logger.info('ClawBot channel not auto-connected (disabled) — use /clawbot login to authorize');
      this.status = 'active'; // 渠道已就绪但未连接（与下方「无 token」分支同语义）
      return;
    }

    // 尝试从缓存恢复 token
    const restored = await this.auth.restoreFromCache();

    if (restored) {
      // 已有有效 token → 直接激活
      await this.activateClient();
    } else if (this.config.botToken) {
      // 配置中直接提供了 botToken
      this.auth.setTokenDirect(this.config.botToken, this.config.botId, this.config.userId);
      this.logger.info('Using botToken from config');
      await this.activateClient();
    } else {
      // 无 token → 不自动弹二维码，等待用户通过 /clawbot login 触发
      this.logger.info('No botToken available — use /clawbot login to authorize');
      this.status = 'active'; // 渠道已启动但未连接
    }
  }

  /** 初始化/更新 HTTP 客户端并启动长轮询 */
  private async activateClient(): Promise<void> {
    if (!this.auth?.token) return;

    const baseUrl = this.config.baseUrl!;
    this.client = new ClawbotClient(baseUrl, this.auth.token, this.config.httpTimeoutMs);

    this.config.botId = this.auth.botIdentifier;
    this.config.userId = this.auth.userIdentifier;

    // ── 注册到 channelLoop 注册表（供定时任务路由） ──
    const registry = (globalThis as any).__channelLoopRegistry as Map<string, {
      notifyTaskFired(name: string, sessionId?: string): Promise<void>;
      sendProactiveMessage?(sessionId: string, text: string): Promise<void>;
      capabilities?: { persistent?: boolean; localDefault?: boolean; fallbackPriority?: number };
    }> | undefined;
    if (registry) {
      registry.set('clawbot', {
        notifyTaskFired: async (name: string, sessionId?: string) => {
          await this.handleTaskNotification(name, sessionId);
        },
        sendProactiveMessage: async (sessionId: string, text: string) => {
          await this.sendProactiveMessage(sessionId, text);
        },
        // 能力声明（核心据此选择，不再写死渠道名）：微信同为持久消息渠道，
        // 但 fallbackPriority 5 < 飞书 10 —— 两者同时在线时仍优先飞书（与历史行为一致），
        // 飞书不在线时才顶上来做兜底（这比原先回落到本地 loop 更合理）。
        capabilities: { persistent: true, fallbackPriority: 5 },
      });
      this.logger.info('registered in channelLoop registry for scheduled task routing');
    }

    // ── 预取 typing ticket ──
    this.fetchTypingConfig().catch(() => {});

    // ── 恢复持久化的 session 映射 ──
    await this.restoreSession();

    // ── 启动长轮询 ──
    this.polling = true;
    this.startPollingLoop();

    // ── 每日 token 检查 ──
    if (!this.dailyCheckTimer) {
      this.dailyCheckTimer = setInterval(() => {
        this.auth?.checkAndWarn();
      }, 24 * 60 * 60 * 1000);
    }

    this.status = 'active';
    this.logger.info(`ClawBot channel active (bot: ${this.auth.botIdentifier}, user: ${this.auth.userIdentifier})`);
  }

  /** 手动触发扫码授权流程（供 /clawbot login 命令调用） */
  async triggerAuth(): Promise<boolean> {
    if (!this.auth) {
      this.logger.error('triggerAuth: auth manager not initialized');
      return false;
    }

    if (this.auth.hasValidToken && this.polling) {
      this.logger.info('Already authorized and polling');
      return true;
    }

    this.logger.info('Starting manual QR code authorization...');
    const ok = await this.auth.startAuthorization();
    if (ok) {
      await this.activateClient();
    } else {
      this.logger.error('Authorization failed or cancelled');
    }
    return ok;
  }

  /** 返回当前授权状态（供 /clawbot status 命令调用） */
  getAuthStatus(): { authorized: boolean; polling: boolean; remainingDays: number; botId: string; userId: string } {
    return {
      authorized: this.auth?.hasValidToken ?? false,
      polling: this.polling,
      remainingDays: this.auth?.remainingDays ?? 0,
      botId: this.auth?.botIdentifier ?? this.config.botId ?? '',
      userId: this.auth?.userIdentifier ?? this.config.userId ?? '',
    };
  }

  // ── Session 持久化 ─────────────────────────────────────────────

  private async persistSession(): Promise<void> {
    try {
      const data: Record<string, string> = {};
      for (const [sid, info] of this.sessionMap) {
        data[info.userId] = sid;
      }
      await fs.mkdir(path.dirname(this.persistSessionFile), { recursive: true });
      await fs.writeFile(this.persistSessionFile, JSON.stringify(data), 'utf-8');
    } catch { /* 写入失败不阻塞 */ }
  }

  private async restoreSession(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistSessionFile, 'utf-8');
      const data = JSON.parse(raw) as Record<string, string>;
      for (const [userId, sid] of Object.entries(data)) {
        if (typeof sid === 'string') {
          this.sessionMap.set(sid, { userId, contextToken: '' });
          this.sessionId = sid;
        }
      }
      if (this.sessionId) {
        this.logger.info(`restored session: ${this.sessionId}`);
      }
    } catch { /* 首次启动无文件，正常 */ }
  }

  /** ChannelHandler: 处理 TUI 子命令（/clawbot/login, /clawbot/status） */
  async handleTuiCommand(cmdPath: string, _args: string): Promise<string | null> {
    if (cmdPath === 'clawbot/login') {
      const ok = await this.triggerAuth();
      return ok ? '✅ ClawBot 授权成功，已开始监听消息'
                : '❌ ClawBot 授权失败或已取消';
    }
    if (cmdPath === 'clawbot/status') {
      const s = this.getAuthStatus();
      return [
        '── ClawBot ──',
        `授权: ${s.authorized ? '✅ 已授权' : '⚠️ 未授权'}`,
        `监听: ${s.polling ? '✅ 运行中' : '⏸ 已暂停'}`,
        `Bot: ${s.botId || '-'}  用户: ${s.userId || '-'}`,
        `Token: ${s.authorized ? s.remainingDays.toFixed(1) + ' 天' : '-'}`,
      ].join('\n');
    }
    return null;
  }

  async stop(): Promise<void> {
    this.logger.info('stopping channel...');
    this.polling = false;
    this.pollAbortController?.abort();
    this.pollAbortController = null;

    if (this.dailyCheckTimer) {
      clearInterval(this.dailyCheckTimer);
      this.dailyCheckTimer = null;
    }

    this.messageQueue.clear();
    this.sessionMap.clear();
    this.loop = null;
    this.collectHandler = null;
    this.sessionId = null;
    this.status = 'stopped';
    this.logger.info('channel stopped');
  }

  onEvent(handler: (event: ChannelEvent) => Promise<void>): void {
    // 初始化消息队列：processFn 调用 eventHandler（ChannelManager.onEvent 回调）
    this.messageQueue.setProcessFn(async (event: ChannelEvent) => {
      await handler(event);
    });
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    if (!this.client) {
      this.logger.error('reply failed: client not initialized');
      return;
    }

    const session = this.sessionMap.get(sessionId);
    if (!session) {
      this.logger.error(`reply failed: session ${sessionId} not found`);
      return;
    }

    const text = reply.content;
    if (!text) return;

    try {
      // 分片发送（微信 ClawBot 保守 2000 字符上限）
      await this.client.sendMessageChunked(
        session.userId,
        session.contextToken,
        text,
        this.config.textChunkLimit ?? 2000,
      );
    } catch (err) {
      this.logger.error(`reply failed: ${err instanceof Error ? err.message : String(err)}`);

      // 检测 token 过期
      if (err instanceof ClawbotAPIError && err.isSessionTimeout) {
        this.logger.info('bot_token expired during reply, triggering re-authorization...');
        await this.handleTokenExpiry();
      }
    }
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  // ── handleMessage ──────────────────────────────────────────────

  async handleMessage(
    event: ChannelMessageEvent,
    replyFn: ReplyFn,
    agentFactory: AgentFactory,
  ): Promise<void> {
    this.agentFactory = agentFactory;

    const userId = (event.metadata?.userId as string) ?? event.userId;

    // TUI 同步
    if (this.config.tuiSync && this.onUserMessage) {
      const label = '微信';
      this.onUserMessage(label, event.content);
    }

    try {
      // 获取或创建 AgentLoop
      if (!this.loop || !this.collectHandler) {
        this.collectHandler = createCollectHandler();
        this.sessionId = event.sessionId;
        const { loop } = await agentFactory.createAgent({
          outputHandler: this.collectHandler,
          sessionId: event.sessionId,
          channel: 'clawbot',
        });
        this.loop = loop;
      }

      this.collectHandler.reset();
      if (event.images?.length) (this.loop as any).channelImages = event.images;

      await this.loop.run(event.content);
      const response = this.collectHandler.getResponse();

      if (response) {
        await replyFn({ content: response });
      }

      if (this.config.tuiSync && this.onAgentReply && response) {
        this.onAgentReply(response);
      }
    } catch (err) {
      this.logger.error(`handleMessage error: ${String(err instanceof Error ? err.message : err)}`);
      try {
        await replyFn({ content: `处理出错: ${err instanceof Error ? err.message : String(err)}` });
      } catch { /* ignore */ }
    }
  }

  // ── 长轮询 ────────────────────────────────────────────────────

  /** 启动长轮询循环（while loop，非递归） */
  private startPollingLoop(): void {
    // 异步启动，不阻塞 start()
    this.runPollLoop().catch(err => {
      this.logger.error(`poll loop fatal: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async runPollLoop(): Promise<void> {
    while (this.polling) {
      if (!this.client) {
        await this.sleep(1000);
        continue;
      }

      try {
        const result = await this.client.getUpdates(this.getUpdatesBuf);

        // 保存 opaque blob
        if (result.get_updates_buf) {
          this.getUpdatesBuf = result.get_updates_buf;
        }

        // 处理消息
        const msgs = result.msgs;
        if (msgs && msgs.length > 0) {
          for (const msg of msgs) {
            await this.handleIncomingMessage(msg);
          }
        }
        // 无消息时（超时返回空），立即发起下一次长轮询
      } catch (err) {
        if (err instanceof ClawbotAPIError && err.isSessionTimeout) {
          // token 过期 → 重新授权
          this.logger.info('bot_token expired, re-authorizing...');
          await this.handleTokenExpiry();
          // 重授权成功后继续轮询
          continue;
        }

        // 其他错误 → 等待后重试
        this.logger.error(`poll error: ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(this.config.pollRetryIntervalMs ?? 3000);
      }
    }
  }

  /** 处理长轮询收到的入站消息 */
  private async handleIncomingMessage(msg: ClawbotIncomingMessage): Promise<void> {
    // ── 过滤非 FINISH 状态的消息 ──
    // GENERATING (1) = 模型还在生成，内容不完整；FINALIZED 由后续 FINISH 消息覆盖
    // NEW (0) = 消息刚刚到达
    if (msg.message_state !== 2) {
      this.logger.info(`skipping message_state=${msg.message_state}`);
      return;
    }

    // ── 过滤 BOT 自身的消息（message_type=2） ──
    if (msg.message_type !== 1) {
      return;
    }

    // ── 提取文本和图片 ──
    let content = '';
    const images: ChannelMessageEvent['images'] = [];

    for (const item of msg.item_list) {
      switch (item.type) {
        case 1: // TEXT
          content += item.text_item?.text ?? '';
          break;
        case 2: // IMAGE
          // 微信图片消息：尝试从 URL 下载（如果提供了 URL）
          if (item.image_item?.url) {
            try {
              const imgResp = await fetch(item.image_item.url);
              if (imgResp.ok) {
                const buf = Buffer.from(await imgResp.arrayBuffer());
                const contentType = imgResp.headers.get('content-type') || 'image/png';
                images.push({ data: buf.toString('base64'), media_type: contentType });
              }
            } catch {
              this.logger.error('failed to download image from ClawBot message');
            }
          }
          break;
        // 语音/文件/视频暂不处理（后续可扩展）
        default:
          break;
      }
    }

    if (!content && images.length === 0) return;

    // ── 更新会话信息 ──
    const userId = msg.from_user_id;
    const contextToken = msg.context_token;

    this.sessionInfo = { userId, contextToken };

    // 生成或复用 sessionId
    let sessionId: string | undefined;
    for (const [sid, info] of this.sessionMap) {
      if (info.userId === userId) {
        sessionId = sid;
        // 更新 contextToken（始终使用最新一条的 token）
        info.contextToken = contextToken;
        break;
      }
    }

    if (!sessionId) {
      sessionId = generateSessionId('clawbot');
      this.sessionMap.set(sessionId, { userId, contextToken });
      this.persistSession().catch(() => {});  // 持久化新 session，重启后复用
    }

    this.sessionId = sessionId;

    // ── 构造 ChannelMessageEvent ──
    const channelEvent: ChannelEvent = {
      type: 'message',
      sessionId,
      userId,
      content,
      channel: this.id,
      images: images.length > 0 ? images : undefined,
      metadata: {
        userId,
        // 使用 context_token 的前 12 位作为消息去重键
        messageId: contextToken.slice(0, 24),
      },
    };

    // 入队（立即返回，不阻塞轮询循环）
    this.messageQueue.enqueue(sessionId, channelEvent);
  }

  // ── Token 过期处理 ────────────────────────────────────────────

  private async handleTokenExpiry(): Promise<void> {
    this.polling = false; // 暂停轮询

    if (this.auth) {
      const ok = await this.auth.refreshToken();
      if (ok && this.auth.token) {
        // 更新客户端的 token
        this.client?.setBotToken(this.auth.token);
        this.logger.info('re-authorization successful, resuming polling');
        this.polling = true;
        this.getUpdatesBuf = ''; // 重置 opaque blob（新 session）
        this.startPollingLoop();
      } else {
        this.status = 'error';
        this.logger.error('re-authorization failed, channel stopped');
      }
    }
  }

  // ── 主动推送 ──────────────────────────────────────────────────

  /**
   * 主动推送消息（非回复模式）。
   * ClawBot 是单会话，直接向最近活跃的用户发送。
   */
  async sendProactiveMessage(sessionId: string, text: string): Promise<void> {
    if (!this.client) {
      this.logger.error('sendProactiveMessage: client not initialized');
      return;
    }

    const session = this.sessionMap.get(sessionId) ?? this.sessionInfo;
    if (!session) {
      this.logger.error('sendProactiveMessage: no session available');
      return;
    }

    try {
      await this.client.sendMessageChunked(
        session.userId,
        session.contextToken,
        text,
        this.config.textChunkLimit ?? 2000,
      );
      this.logger.info(`proactive message sent to ${sessionId.slice(0, 16)}...`);
    } catch (err) {
      this.logger.error(`sendProactiveMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 处理定时任务通知。
   * 运行 Agent 并将结果主动推送到 ClawBot 会话。
   */
  async handleTaskNotification(taskName: string, sessionId?: string): Promise<void> {
    const effectiveSessionId = sessionId ?? this.sessionId;
    if (!effectiveSessionId) {
      this.logger.error('handleTaskNotification: no session available');
      return;
    }

    const loop = this.loop;
    if (!loop) {
      this.logger.error('handleTaskNotification: no loop available — no message has been processed yet');
      return;
    }

    const queued = await this.hasQueuedMessage(effectiveSessionId);
    if (queued) {
      this.logger.info(`handleTaskNotification: session ${effectiveSessionId.slice(0, 16)}... has queued messages, skipping task`);
      return;
    }

    const prompt = `[Scheduled Task Triggered]\nYour scheduled task "${taskName}" has just been triggered via WeChat ClawBot. Execute it now and respond naturally. If this was a one-shot task, it has completed — no need to reschedule.`;

    const texts: string[] = [];
    const taskHandler: ChannelOutputHandler = {
      onTurnStart: () => { texts.length = 0; },
      onText: (text) => { texts.push(text); },
      onStatus: (msg, level) => { this.logger.info(`[clawbot-task] ${level}: ${msg}`); },
    };

    loop.setOutputHandler(taskHandler);
    try {
      await loop.run(prompt);
      const response = texts.join('').trim();
      if (response) {
        await this.sendProactiveMessage(effectiveSessionId, response);
      } else {
        this.logger.info(`handleTaskNotification: task "${taskName}" produced no text output`);
      }
    } catch (err) {
      this.logger.error(`handleTaskNotification error: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      // 恢复原 handler
      if (this.collectHandler) {
        loop.setOutputHandler(this.collectHandler);
      }
    }
  }

  // ── typing 提示 ───────────────────────────────────────────────

  /** 获取 typing_ticket（预取一次，缓存使用） */
  private async fetchTypingConfig(): Promise<void> {
    if (!this.client || this.typingConfigFetched) return;
    try {
      const cfg = await this.client.getConfig();
      if (cfg.typing_ticket) {
        this.typingTicket = cfg.typing_ticket;
        this.typingConfigFetched = true;
      }
    } catch {
      // 非关键，失败不影响功能
    }
  }

  // ── 工具 ──────────────────────────────────────────────────────

  private async hasQueuedMessage(sessionId: string): Promise<boolean> {
    return this.messageQueue.getQueueSize(sessionId) > 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── 工厂函数 ─────────────────────────────────────────────────

export function createClawbotChannel(): ClawbotChannel {
  return new ClawbotChannel();
}
