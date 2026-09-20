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
 * 修复的正是"产得出来、认不出来"缺口：生产侧一直造得出 clawbot_xxx（会话归属前缀），
 * 但注册表里从来没有 clawbot_，导致会话归属永远推断不出、渠道隔离失效。
 * 现由插件在 autoRegister 开头无条件登记（与 enabled 无关）。
 */
export const CLAWBOT_SESSION_PREFIX = 'clawbot_';
import type {
  ChannelHandler,
  ChannelEvent,
  ChannelReply,
  ChannelConfig,
  ChannelStatus,
  ChannelMessageEvent,
} from '../../interface.js';
import {
  resolveClawbotConfig,
  type ClawbotChannelConfig,
} from './clawbot-config.js';
import { ClawbotClient, ClawbotAPIError, type ClawbotIncomingMessage, type ImageItem } from './clawbot-client.js';
import { ClawbotAuthManager, type AuthCallbacks } from './clawbot-auth.js';
import { ClawbotMessageQueue } from './clawbot-message-queue.js';
import { ClawbotTypingController } from './clawbot-typing.js';
import crypto from 'node:crypto';

// ── 微信图片下载 + 解密 ───────────────────────────────────────

/**
 * 下载并解密微信 ClawBot 图片（**实测结论**，2026-09-19：真实抓包 + 本地解密验证）。
 *
 * 微信**不给可直接使用的图片 URL**，而是：
 *   · `image_item.media.full_url` —— CDN 下载地址（带 encrypted_query_param 凭据）
 *   · `image_item.aeskey`         —— 32 位 hex 字符串，**hex 解码为 16 字节**即 AES-128 密钥
 *   · `image_item.media.aes_key`  —— 同一把密钥的 base64 形式（解开就是那串 hex）
 *
 * ⚠ 下载回来的是**密文**，必须解密后才是真正的图片字节：
 *   算法 **AES-128-ECB**、填充默认 **PKCS#7**、无 IV。
 *   取错字段（旧代码认 `image_item.url`，而微信并不下发）或漏掉解密，
 *   图片就会被"静默丢弃" —— 这正是此前的 bug。
 *
 * 失败一律返回 null（由调用方记日志），不抛：单张图拿不到不应拖垮整条消息。
 *
 * （导出**仅供测试**：用自造密文把"hex 密钥 + AES-128-ECB + PKCS#7"这套常量钉死 ——
 *   它是实测结论，协议里没有任何东西会提醒后人别改坏它。）
 */
export async function fetchWeixinImage(
  image: ImageItem['image_item'],
): Promise<{ data: string; media_type: string } | null> {
  try {
    const url = image.media?.full_url;
    if (!url) return null;

    // 密钥：优先 aeskey（hex）；缺失时从 media.aes_key（base64）还原出同一串 hex
    const keyHex =
      image.aeskey ??
      (image.media?.aes_key
        ? Buffer.from(image.media.aes_key, 'base64').toString('utf8')
        : undefined);
    if (!keyHex || !/^[0-9a-fA-F]{32}$/.test(keyHex)) return null;

    const resp = await fetch(url);
    if (!resp.ok) return null;
    const cipher = Buffer.from(await resp.arrayBuffer());

    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null);
    const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);

    // 魔数自检：密钥不对时绝不把垃圾字节当图片塞进上下文
    const mediaType =
      plain[0] === 0xff && plain[1] === 0xd8 ? 'image/jpeg'
        : plain[0] === 0x89 && plain[1] === 0x50 ? 'image/png'
          : plain[0] === 0x47 && plain[1] === 0x49 ? 'image/gif'
            : null;
    if (!mediaType) return null;

    return { data: plain.toString('base64'), media_type: mediaType };
  } catch {
    // ⚠ 密钥不对时 `decipher.final()` 会**抛** bad decrypt（PKCS#7 去填充失败），
    //   而不是安静地返回垃圾字节 —— 所以这里必须兜住，才能兑现"失败一律返回 null"的契约。
    return null;
  }
}

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
  /** 能力声明：微信同为持久消息渠道，fallbackPriority 5 < 飞书 10（两者在线时优先飞书） */
  readonly loopCapabilities = { persistent: true, fallbackPriority: 5 } as const;

  private status: ChannelStatus = 'registered';
  private config!: ClawbotChannelConfig;
  private logger: Logger = defaultLogger();

  // ── 核心依赖 ──────────────────────────────────────────────────
  private client: ClawbotClient | null = null;
  private auth: ClawbotAuthManager | null = null;
  private messageQueue = new ClawbotMessageQueue();

  // ── 长轮询状态 ────────────────────────────────────────────────
  private polling = false;
  private pollAbortController: AbortController | null = null;
  /** getUpdates 的 opaque blob，首次空字符串，后续回传上次返回值 */
  private getUpdatesBuf = '';

  // ── 会话状态（传输态：只记「往哪发」，不解析/不创建会话） ──────
  /** 单会话信息（ClawBot 只有一个会话） */
  private sessionInfo: SessionInfo | null = null;

  // ── typing 状态 ──────────────────────────────────────────────
  /**
   * typing_ticket（per-user，由 getConfig 取得）。
   * 空串 = 不可用 → 整条 typing 链路静默降级为 no-op，绝不影响消息收发。
   */
  private typingTicket = '';
  /** 已成功取得 ticket 的对端 userId；与当前 userId 不符时需重新获取 */
  private typingTicketUserId = '';
  /** typing 控制器：会话期间维持「正在输入」状态（本渠道单会话，故仅需一个实例） */
  private typingController: ClawbotTypingController | null = null;

  // ── TUI 同步 ─────────────────────────────────────────────────
  private onUserMessage: ((label: string, content: string) => void) | null = null;
  private onAgentReply: ((content: string) => void) | null = null;

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

    // ── 会话恢复由内核 SessionService 统一负责（manager.startChannel → bindChannel）──
    // 渠道不再持有 sessionId：单会话策略（identity→default 键）由内核身份映射持久化，
    // 重启后首条消息自动复用恢复的会话目录。本渠道不再自行解析/持久化会话。

    // ── typing 提示 ──
    // 注意：typing_ticket 是 **per-user** 的（官方 getconfig 要求 ilink_user_id），
    // 启动时尚无对端 userId，无法预取。改为在首条消息到达时按需获取，
    // 见 handleIncomingMessage → ensureTypingTicket()。

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
    this.sessionInfo = null;
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

    // 单会话渠道：回复目标恒为当前对端会话
    const session = this.sessionInfo;
    if (!session) {
      this.logger.error(`reply failed: no active conversation for ${sessionId}`);
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

      // TUI 同步（回复文本）
      if (this.config.tuiSync && this.onAgentReply) {
        this.onAgentReply(text);
      }
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
          // 微信图片**不给可直接用的 URL**：内容在 CDN 上是 AES-128-ECB 密文，
          // 须 media.full_url 下载 + aeskey 解密（实测结论，详见 fetchWeixinImage）。
          // 旧实现只认 `image_item.url`（微信实际不下发此字段）⇒ 图片被静默丢弃；
          // 纯图片消息更会在下方 `!content && images.length === 0` 处直接 return、连队列都不进。
          try {
            const img = await fetchWeixinImage(item.image_item);
            if (img) images.push(img);
            else this.logger.error('clawbot image: 字段缺失或下载/解密失败，已跳过');
          } catch (err) {
            this.logger.error(
              `clawbot image failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        // 语音/文件/视频暂不处理（后续可扩展）
        default:
          break;
      }
    }

    if (!content && images.length === 0) return;

    // ── 更新会话信息（传输态：回复目标绑定） ──
    const userId = msg.from_user_id;
    const contextToken = msg.context_token;

    this.sessionInfo = { userId, contextToken };

    // TUI 同步（用户消息）
    if (this.config.tuiSync && this.onUserMessage) {
      this.onUserMessage('微信', content);
    }

    // ── 构造 ChannelMessageEvent ──
    // 会话主控权归内核（SessionService 单点解析）：渠道只提供身份（userId），
    // **不解析/不决定 sessionId**。单会话策略由内核按 identity 派生（default 键），
    // 重启后首条消息自动复用恢复的会话目录。
    const channelEvent: ChannelEvent = {
      type: 'message',
      userId,
      content,
      channel: this.id,
      identity: { userId },
      images: images.length > 0 ? images : undefined,
      metadata: {
        userId,
        // 使用 context_token 的前 12 位作为消息去重键
        messageId: contextToken.slice(0, 24),
      },
    };

    // 入队（立即返回，不阻塞轮询循环）；单会话渠道队列键恒为 'default'
    this.messageQueue.enqueue('default', channelEvent);
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

    // 单会话渠道：目标恒为当前对端
    const session = this.sessionInfo;
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

  // ── typing 提示（「对方正在输入」） ────────────────────────────
  //
  // 协议：POST /ilink/bot/sendtyping，需先由 /ilink/bot/getconfig 取得 typing_ticket。
  // 细节见桌面交接文档《微信typing-交接》；控制器实现见 clawbot-typing.ts。
  //
  // 设计约束：
  //   1. typing_ticket 是 **per-user** 的 → 首条消息到达后才能获取，启动时无法预取
  //   2. 全链路**静默降级**：拿不到 ticket 或发送失败，只记日志，绝不阻断消息收发

  /** 当前 controller 绑定的对端 userId（换人时需重建 controller） */
  private typingBoundUserId = '';

  /**
   * 确保 typing_ticket 就绪（按 userId 缓存）。
   * @returns ticket；不可用时返回空串（调用方据此降级为 no-op）
   */
  private async ensureTypingTicket(userId: string, contextToken?: string): Promise<string> {
    if (!this.client) return '';

    // 同一用户且已有 ticket → 复用
    if (this.typingTicket && this.typingTicketUserId === userId) {
      return this.typingTicket;
    }

    try {
      const cfg = await this.client.getConfig(userId, contextToken);
      if (cfg.typing_ticket) {
        this.typingTicket = cfg.typing_ticket;
        this.typingTicketUserId = userId;
        return this.typingTicket;
      }
      this.logger.info('getConfig returned no typing_ticket — typing disabled');
    } catch (err) {
      // 非关键：失败仅降级，不影响消息收发
      this.logger.info(`getConfig failed (typing disabled): ${err instanceof Error ? err.message : String(err)}`);
    }

    this.typingTicket = '';
    this.typingTicketUserId = '';
    return '';
  }

  /**
   * 开始「正在输入」状态。
   * 拿不到 ticket 时静默 no-op —— typing 永远是「锦上添花」，不得影响主流程。
   */
  private async startTyping(userId: string, contextToken?: string): Promise<void> {
    const client = this.client;
    if (!client) return;

    const ticket = await this.ensureTypingTicket(userId, contextToken);
    if (!ticket) return;

    // 换了对端用户 → 重建 controller（单会话渠道，平时不会走到）
    if (this.typingController && this.typingBoundUserId !== userId) {
      this.typingController.stop();
      this.typingController = null;
    }

    if (!this.typingController) {
      this.typingController = new ClawbotTypingController({
        // ticket 动态读取（可能被刷新），避免闭包捕获旧值
        send: (status) => client.sendTyping(userId, this.typingTicket, status),
        log: (msg) => this.logger.info(msg),
      });
      this.typingBoundUserId = userId;
    }

    this.typingController.start();
  }

  /** 停止「正在输入」。幂等 —— 调用方必须放在 finally 中。 */
  private stopTyping(): void {
    this.typingController?.stop();
  }

  // ── loop 生命周期钩子（内核编排回调；替代旧 handleMessage 里的 startTyping/stopTyping） ──

  /** 内核在 loop.run 前回调：开始「正在输入」 */
  async onLoopStart(event: ChannelMessageEvent, _sessionId: string): Promise<void> {
    const userId = (event.metadata?.userId as string) ?? event.userId;
    const contextToken = this.sessionInfo?.contextToken;
    await this.startTyping(userId, contextToken);
  }

  /** 内核在 loop.run 后回调（无论成功/异常）：停止「正在输入」 */
  async onLoopEnd(_sessionId: string): Promise<void> {
    this.stopTyping();
  }

  // ── 工具 ──────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── 工厂函数 ─────────────────────────────────────────────────

export function createClawbotChannel(): ClawbotChannel {
  return new ClawbotChannel();
}
