// ============================================================
// ClawbotClient — 封装 ClawBot iLink API 全部 HTTP 调用
// ============================================================
//
// 底层协议：iLink（智联）协议，标准 HTTP/JSON
// 主域名：https://ilinkai.weixin.qq.com
// CDN 域名：https://novac2c.cdn.weixin.qq.com/c2c
//
// 全部 7 个接口：
//   1. getQRCode           — 获取登录二维码
//   2. getQRCodeStatus     — 轮询扫码状态
//   3. getUpdates          — 长轮询接收消息
//   4. sendMessage         — 发送/回复消息
//   5. sendTyping          — 发送「正在输入」状态
//   6. getConfig           — 获取配置（typing_ticket 等）
//   7. getUploadUrl        — 获取媒体上传地址
// ============================================================

import crypto from 'node:crypto';

// ── 类型定义 ──────────────────────────────────────────────────

export interface QRCodeResult {
  qrcode: string;               // 轮询令牌
  qrcode_img_content: string;   // 二维码 URL（HTTPS 链接）
}

export type QRCodeStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'binded_redirect';

export interface QRCodeStatusResult {
  status: QRCodeStatus;
  /** 确认后的 bot_token（仅 confirmed 时有值） */
  bot_token?: string;
  /** bot 用户 ID，格式 xxx@im.bot */
  ilink_bot_id?: string;
  /** 微信用户 ID，格式 xxx@im.wechat */
  ilink_user_id?: string;
  /** API 根域名 */
  baseurl?: string;
}

export type MessageItemType = 1 | 2 | 3 | 4 | 5;
// 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO

export type MessageType = 1 | 2;
// 1=USER(入站), 2=BOT(出站)

export type MessageState = 0 | 1 | 2;
// 0=NEW, 1=GENERATING, 2=FINISH

export interface TextItem {
  type: 1;
  text_item: { text: string };
}

export interface ImageItem {
  type: 2;
  image_item: {
    /** 图片宽度 */
    width?: number;
    /** 图片高度 */
    height?: number;
    /**
     * 旧字段：CDN URL。
     * ⚠ 2026-09-19 实测：微信**并不下发这个字段**（见下方 media）——
     * 曾经据此判断是否下载，导致图片被静默丢弃。
     */
    url?: string;
    /**
     * 实测字段（2026-09-19 抓包确认）：32 位 hex 字符串。
     * **hex 解码成 16 字节**后即 AES-128 密钥。
     */
    aeskey?: string;
    /** 实测字段：媒体描述符（真正的下载地址与密钥都在这里） */
    media?: {
      /** 下载凭据（拼在 full_url 的 query 里，两者等价） */
      encrypt_query_param?: string;
      /** 同一把密钥的 base64 形式（解开就是 aeskey 那串 hex） */
      aes_key?: string;
      /** CDN 下载地址；**下载回来的是密文**，需用 aeskey 解密 */
      full_url?: string;
    };
    /** 实测字段：各档位字节数 */
    hd_size?: number;
    mid_size?: number;
    thumb_size?: number;
    thumb_width?: number;
    thumb_height?: number;
  };
}

export interface VoiceItem {
  type: 3;
  voice_item: Record<string, unknown>;
}

export interface FileItem {
  type: 4;
  file_item: Record<string, unknown>;
}

export interface VideoItem {
  type: 5;
  video_item: Record<string, unknown>;
}

export type MessageItem = TextItem | ImageItem | VoiceItem | FileItem | VideoItem;

/** 入站消息（来自 getUpdates） */
export interface ClawbotIncomingMessage {
  from_user_id: string;          // 发送方，格式 xxx@im.wechat
  to_user_id: string;            // 接收方，格式 xxx@im.bot
  message_type: MessageType;     // 1=USER
  message_state: MessageState;   // 0=NEW, 1=GENERATING, 2=FINISH
  context_token: string;         // 上下文令牌（回复时必须回传）
  item_list: MessageItem[];
}

/** 出站消息（传给 sendMessage） */
export interface ClawbotOutgoingMessage {
  to_user_id: string;
  client_id: string;
  message_type: 2;               // 出站固定 BOT=2
  message_state: 2;              // 出站固定 FINISH=2
  context_token: string;
  item_list: MessageItem[];
}

export interface GetUpdatesRequest {
  get_updates_buf: string;       // 首次空字符串，后续回传上次返回值
  base_info?: { channel_version?: string };
}

export interface GetUpdatesResponse {
  ret: number;
  msgs?: ClawbotIncomingMessage[];
  get_updates_buf?: string;      // opaque blob，下次请求原样回传
  longpolling_timeout_ms?: number;
}

export interface SendMessageRequest {
  msg: ClawbotOutgoingMessage;
  base_info?: { channel_version?: string };
}

export interface SendMessageResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
}

/**
 * getconfig 请求体。
 *
 * ⚠️ 官方插件此处用 `ilink_user_id`（typing_ticket 是 per-user 的），
 * **不是** sendMessage 的 `to_user_id`。早期实现传了空 body `{}`，
 * 故拿不到有效 ticket（2026-09-17 对照官方源码修正）。
 */
export interface GetConfigRequest {
  ilink_user_id: string;
  context_token?: string;
  base_info?: { channel_version?: string };
}

export interface GetConfigResponse {
  ret: number;
  typing_ticket?: string;
}

/**
 * sendtyping 请求体。
 *
 * ⚠️ 字段名与 sendMessage 不同：官方用顶层 `ilink_user_id` + `status`，
 * 而非 `to_user_id` + `context_token`。早期实现误用了后者，
 * 且该方法从未被任何代码调用，故字段错误长期未暴露（2026-09-17 修正）。
 */
export interface SendTypingRequest {
  ilink_user_id: string;
  typing_ticket: string;
  /** 1=开始输入，2=取消输入（见 clawbot-typing.ts 的 TYPING_STATUS） */
  status?: number;
  base_info?: { channel_version?: string };
}

export interface GetUploadUrlRequest {
  file_name?: string;
  file_size?: number;
  content_type?: string;
}

export interface GetUploadUrlResponse {
  ret: number;
  upload_url?: string;
  errcode?: number;
  errmsg?: string;
}

// ── 错误类型 ──────────────────────────────────────────────────

export class ClawbotAPIError extends Error {
  constructor(
    message: string,
    public ret?: number,
    public errcode?: number,
  ) {
    super(message);
    this.name = 'ClawbotAPIError';
  }

  /** errcode:-14 表示 session timeout / bot_token 过期 */
  get isSessionTimeout(): boolean {
    return this.errcode === -14 || this.ret === -14;
  }
}

// ── ClawbotClient ─────────────────────────────────────────────

export class ClawbotClient {
  private baseUrl: string;
  private botToken: string;
  private httpTimeoutMs: number;
  private channelVersion: string;

  constructor(
    baseUrl: string,
    botToken: string,
    httpTimeoutMs = 30_000,
    channelVersion = '1.0.0',
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.botToken = botToken;
    this.httpTimeoutMs = httpTimeoutMs;
    this.channelVersion = channelVersion;
  }

  /** 更新 bot_token（授权成功 / 重新扫码后调用） */
  setBotToken(token: string): void {
    this.botToken = token;
  }

  // ── 鉴权 ────────────────────────────────────────────────────

  /** 生成 X-WECHAT-UIN 防重放随机值 */
  private generateWechatUin(): string {
    return crypto.randomBytes(16).toString('base64');
  }

  /** 构建 POST 请求的鉴权头 */
  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.botToken}`,
      'X-WECHAT-UIN': this.generateWechatUin(),
    };
  }

  // ── HTTP 底层 ───────────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = await resp.json() as T;

      // 检查业务错误码
      const err = json as unknown as { ret?: number; errcode?: number; errmsg?: string; err_msg?: string };
      if ((err.ret !== undefined && err.ret !== 0) || (err.errcode !== undefined && err.errcode !== 0)) {
        throw new ClawbotAPIError(
          err.errmsg ?? err.err_msg ?? `API error: ret=${err.ret}, errcode=${err.errcode}`,
          err.ret,
          err.errcode,
        );
      }

      return json;
    } catch (err) {
      if (err instanceof ClawbotAPIError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ClawbotAPIError(`HTTP timeout after ${this.httpTimeoutMs}ms: ${path}`);
      }
      throw new ClawbotAPIError(
        `HTTP request failed: ${path} — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      const json = await resp.json() as T;

      const err = json as unknown as { ret?: number; err_msg?: string };
      if (err.ret !== undefined && err.ret !== 0) {
        throw new ClawbotAPIError(
          err.err_msg ?? `API error: ret=${err.ret}`,
          err.ret,
        );
      }

      return json;
    } catch (err) {
      if (err instanceof ClawbotAPIError) throw err;
      throw new ClawbotAPIError(
        `HTTP request failed: ${path} — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 1. 获取登录二维码 ──────────────────────────────────────

  /**
   * 获取绑定二维码，发起授权流程。
   * bot_type 固定为 3。
   *
   * v2.x 使用 POST 方式，支持 local_token_list 参数。
   */
  async getQRCode(localTokenList: string[] = []): Promise<QRCodeResult> {
    const result = await this.post<QRCodeResult & { ret: number }>(
      `/ilink/bot/get_bot_qrcode?bot_type=3`,
      { local_token_list: localTokenList },
    );
    return result;
  }

  // ── 2. 轮询扫码授权状态 ────────────────────────────────────

  /** 轮询扫码状态，返回状态及 token 信息 */
  async getQRCodeStatus(qrcode: string): Promise<QRCodeStatusResult> {
    const result = await this.get<QRCodeStatusResult & { ret: number }>(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    );
    return result;
  }

  // ── 3. 长轮询接收消息 ──────────────────────────────────────

  /**
   * 长轮询接收用户消息。
   * 服务端挂起超时约 35s，有消息立即返回，无消息等待至超时返回空。
   *
   * @param getUpdatesBuf 上次返回的 opaque blob，首次传空字符串
   */
  async getUpdates(getUpdatesBuf: string): Promise<GetUpdatesResponse> {
    const body: GetUpdatesRequest = {
      get_updates_buf: getUpdatesBuf,
      base_info: { channel_version: this.channelVersion },
    };
    // 长轮询超时要比普通 HTTP 请求长（服务端 35s + 5s 缓冲）
    const pollUrl = `${this.baseUrl}/ilink/bot/getupdates`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);

    try {
      const resp = await fetch(pollUrl, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = await resp.json() as GetUpdatesResponse;

      // ret !== 0 且不是超时（无消息）时抛出错误
      if (json.ret !== undefined && json.ret !== 0 && !json.msgs) {
        throw new ClawbotAPIError(
          `getUpdates error: ret=${json.ret}`,
          json.ret,
        );
      }

      return json;
    } catch (err) {
      if (err instanceof ClawbotAPIError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        // 超时是正常的——服务端 35s 无消息，返回空结果
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw new ClawbotAPIError(
        `getUpdates failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 4. 发送/回复消息 ────────────────────────────────────────

  /**
   * 向微信 ClawBot 会话发送消息。
   *
   * @param toUserId 接收方 ID（ilink_user_id，格式 xxx@im.wechat）
   * @param contextToken 对应用户消息的上下文令牌（必填）
   * @param text 文本内容
   * @param images 图片列表（已上传到 CDN 的 URL）
   */
  async sendMessage(
    toUserId: string,
    contextToken: string,
    text: string,
    images?: Array<{ url: string; width?: number; height?: number }>,
  ): Promise<SendMessageResponse> {
    const itemList: MessageItem[] = [];

    // 先图片后文本
    if (images?.length) {
      for (const img of images) {
        itemList.push({
          type: 2,
          image_item: {
            url: img.url,
            width: img.width,
            height: img.height,
          },
        });
      }
    }

    if (text) {
      itemList.push({
        type: 1,
        text_item: { text },
      });
    }

    const msg: ClawbotOutgoingMessage = {
      to_user_id: toUserId,
      client_id: `clawbot:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: itemList,
    };

    const body: SendMessageRequest = {
      msg,
      base_info: { channel_version: this.channelVersion },
    };

    return this.post<SendMessageResponse>('/ilink/bot/sendmessage', body);
  }

  /**
   * 分片发送长文本消息。
   * 保守上限 2000 字符/条，优先在 \n\n 处切割，其次 \n 处，再次空格处。
   * 每条分片使用不同的 client_id。
   *
   * @returns 发送的分片数量
   */
  async sendMessageChunked(
    toUserId: string,
    contextToken: string,
    text: string,
    chunkLimit = 2000,
  ): Promise<number> {
    if (text.length <= chunkLimit) {
      await this.sendMessage(toUserId, contextToken, text);
      return 1;
    }

    const chunks = this.splitText(text, chunkLimit);
    for (let i = 0; i < chunks.length; i++) {
      // 每条分片等待一小段时间，避免限流
      if (i > 0) await this.sleep(200);

      const chunk = chunks[i];
      const suffix = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '';
      await this.sendMessage(toUserId, contextToken, chunk + suffix);
    }
    return chunks.length;
  }

  /** 文本分片：优先在 \n\n、\n、空格处切割 */
  private splitText(text: string, limit: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > limit) {
      let cutAt = limit;
      // 优先找双换行
      const doubleNewline = remaining.lastIndexOf('\n\n', limit);
      if (doubleNewline > limit * 0.5) {
        cutAt = doubleNewline + 2;
      } else {
        // 其次找单换行
        const singleNewline = remaining.lastIndexOf('\n', limit);
        if (singleNewline > limit * 0.5) {
          cutAt = singleNewline + 1;
        } else {
          // 最后找空格
          const space = remaining.lastIndexOf(' ', limit);
          if (space > limit * 0.5) {
            cutAt = space + 1;
          }
        }
      }
      chunks.push(remaining.slice(0, cutAt).trim());
      remaining = remaining.slice(cutAt).trim();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
  }

  // ── 5. 发送「正在输入」状态 ────────────────────────────────

  /**
   * 向用户发送「正在输入」状态提示。
   *
   * ⚠️ 字段名与 sendMessage 不同：官方此处用顶层 `ilink_user_id` + `status`，
   * 而非 sendMessage 的 `msg.to_user_id` + `context_token`。
   * 早期实现误用了后者，且本方法从未被调用过，故错误长期未暴露
   * （2026-09-17 对照官方 @tencent-weixin/openclaw-weixin 源码修正）。
   *
   * @param ilinkUserId 对端用户 ID（= 入站消息 from_user_id，格式 xxx@im.wechat）
   * @param typingTicket 由 getConfig 取得（per-user）
   * @param status 1=开始输入，2=取消输入（见 clawbot-typing.ts 的 TYPING_STATUS）
   */
  async sendTyping(
    ilinkUserId: string,
    typingTicket: string,
    status: number = 1,
  ): Promise<void> {
    const body: SendTypingRequest = {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
      base_info: { channel_version: this.channelVersion },
    };
    await this.post('/ilink/bot/sendtyping', body);
  }

  // ── 6. 获取配置 ────────────────────────────────────────────

  /**
   * 获取服务端配置（含 typing_ticket），用于 sendTyping。
   *
   * ⚠️ 官方要求传 `ilink_user_id`；早期实现传空 body `{}`，拿不到有效 ticket
   * （2026-09-17 修正）。
   */
  async getConfig(
    ilinkUserId: string,
    contextToken?: string,
  ): Promise<GetConfigResponse> {
    const body: GetConfigRequest = {
      ilink_user_id: ilinkUserId,
      base_info: { channel_version: this.channelVersion },
    };
    if (contextToken) body.context_token = contextToken;
    return this.post<GetConfigResponse>('/ilink/bot/getconfig', body);
  }

  // ── 7. 获取媒体上传地址 ────────────────────────────────────

  /**
   * 获取媒体文件上传地址。
   * 上传完成后通过 sendMessage 引用该媒体文件。
   */
  async getUploadUrl(
    fileName: string,
    fileSize: number,
    contentType: string,
  ): Promise<GetUploadUrlResponse> {
    const body: GetUploadUrlRequest = {
      file_name: fileName,
      file_size: fileSize,
      content_type: contentType,
    };
    return this.post<GetUploadUrlResponse>('/ilink/bot/getuploadurl', body);
  }

  // ── 工具 ────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── DOMException 类型（Node.js 环境） ────────────────────────

// fetch AbortController 在 Node.js 中抛出 DOMException
// 为避免类型错误，使用运行时检查
declare class DOMException extends Error {
  readonly name: string;
}
