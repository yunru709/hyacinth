// ============================================================
// QqClient — NapCat (OneBot v11) HTTP + WebSocket 客户端
// ============================================================
//
// 两条通道，职责分离：
//   HTTP :3000  → 主动调用（send_private_msg / send_group_msg / get_login_info / get_friend_list）
//   WS   :3001  → 被动接收（post_type=message / notice / request / meta_event）
//
// 为什么不用 HTTP 轮询收消息：OneBot v11 的 message 事件是**推送**语义，
// HTTP 端没有「取一批未读」的接口。实测 get_doubt_friends_add_request 这类
// 查询接口只返回特定子集（"可疑"申请），普通好友申请/普通消息都拿不到 ——
// 这是 2026-11-08 加好友时踩过的坑：轮询查不到，必须挂 WS。
//
// 断线重连：ws 库不做自动重连，本类自己退避重连（3s → 指数封顶 30s）。
// ============================================================

import WebSocket from 'ws';

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

// ── OneBot v11 事件结构（只声明用得到的字段）──────────────

/** OneBot 消息段（array 格式） */
export interface Ob11MessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

/** OneBot v11 消息事件 */
export interface Ob11MessageEvent {
  post_type: 'message';
  message_type: 'private' | 'group';
  sub_type?: string;
  /** 私聊 = 发送者 QQ；群聊 = 发送者 QQ */
  user_id: number;
  /** 群号（仅 group） */
  group_id?: number;
  /** 纯文本（CQ 码已展开） */
  raw_message?: string;
  /** 消息段数组（配置 messagePostFormat=array 时） */
  message?: Ob11MessageSegment[] | string;
  message_id: number;
  self_id: number;
  time: number;
  sender?: {
    user_id?: number;
    nickname?: string;
    card?: string;
  };
}

/** OneBot v11 通用事件（其它 post_type） */
export interface Ob11Event {
  post_type: string;
  [key: string]: unknown;
}

export type Ob11AnyEvent = Ob11MessageEvent | Ob11Event;

/** 从消息段数组中提取纯文本（丢弃图片/表情/at 等非文本段） */
export function extractText(event: Ob11MessageEvent): string {
  const msg = event.message;
  if (Array.isArray(msg)) {
    const parts: string[] = [];
    for (const seg of msg) {
      if (seg.type === 'text' && typeof seg.data?.text === 'string') {
        parts.push(seg.data.text);
      } else if (seg.type === 'at' && typeof seg.data?.qq === 'string') {
        // at 段保留成文本标记，便于模型知道被 @ 了
        parts.push(`@${seg.data.qq}`);
      }
    }
    const joined = parts.join('').trim();
    return joined || (event.raw_message ?? '').trim();
  }
  if (typeof msg === 'string') return msg.trim();
  return (event.raw_message ?? '').trim();
}

/** 是否 @ 了我 */
export function isMentioned(event: Ob11MessageEvent, selfId: string): boolean {
  const msg = event.message;
  if (!Array.isArray(msg) || !selfId) return false;
  return msg.some((seg) => seg.type === 'at' && String(seg.data?.qq) === selfId);
}

// ── 客户端 ────────────────────────────────────────────────────

export class QqClient {
  private httpUrl: string;
  private wsUrl: string;
  private accessToken: string;
  private httpTimeoutMs: number;
  private reconnectIntervalMs: number;
  private logger: Logger;

  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private onEvent: ((event: Ob11AnyEvent) => void) | null = null;
  private onConnected: (() => void) | null = null;
  private onDisconnected: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * WS 候选地址（双栈回退）。
   *
   * 为什么需要：NapCat 的 `websocketServers` 虽然配 `host: "0.0.0.0"`，
   * 实际 `ss` 显示绑定成 `*:3001`（IPv6 通配），而 HTTP 那侧是 `0.0.0.0:3000`。
   * WSL2 的 localhost 端口转发只处理 **IPv4** 通配绑定 ⇒ Windows 侧连
   * `127.0.0.1:3001` 得到 ECONNREFUSED，但 `[::1]:3001` 实测可连。
   * （2026-11-08 实测：3000 IPv4 通，3001 IPv4 拒 / IPv6 ::1 通）
   *
   * 处理：127.0.0.1 / localhost 时额外追加 IPv6 loopback 作为备选，
   * 连不上就换下一个 —— 避免把「本机 NapCat 的绑定细节」变成用户必须懂的配置项。
   */
  private wsCandidates: string[] = [];
  private wsCandidateIdx = 0;

  constructor(
    opts: { httpUrl: string; wsUrl: string; accessToken?: string; httpTimeoutMs?: number; reconnectIntervalMs?: number },
    logger?: Logger,
  ) {
    this.httpUrl = opts.httpUrl.replace(/\/+$/, '');
    this.wsUrl = opts.wsUrl;
    this.accessToken = opts.accessToken ?? '';
    this.httpTimeoutMs = opts.httpTimeoutMs ?? 15_000;
    this.reconnectIntervalMs = opts.reconnectIntervalMs ?? 3_000;
    this.logger = logger ?? defaultLogger();
  }

  // ── HTTP 调用 ─────────────────────────────────────────────

  /** 调一个 OneBot action，返回 data 字段（失败抛错） */
  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.httpUrl}/${action}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const body = (await resp.json()) as { status?: string; retcode?: number; data?: T; message?: string; wording?: string };
      if (body.status === 'failed' || (body.retcode !== undefined && body.retcode !== 0)) {
        throw new Error(`OneBot ${action} failed: retcode=${body.retcode} ${body.message ?? body.wording ?? ''}`);
      }
      return body.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 发私聊消息 */
  async sendPrivate(userId: number | string, text: string): Promise<void> {
    await this.call('send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'text', data: { text } }],
    });
  }

  /** 发群消息 */
  async sendGroup(groupId: number | string, text: string): Promise<void> {
    await this.call('send_group_msg', {
      group_id: Number(groupId),
      message: [{ type: 'text', data: { text } }],
    });
  }

  /** 取登录号信息（拿 self_id / 昵称） */
  async getLoginInfo(): Promise<{ user_id: number; nickname: string }> {
    return this.call('get_login_info');
  }

  /** 健康检查 */
  async getStatus(): Promise<{ online: boolean; good: boolean }> {
    return this.call('get_status');
  }

  // ── WebSocket 接收 ────────────────────────────────────────

  setHandlers(handlers: {
    onEvent?: (event: Ob11AnyEvent) => void;
    onConnected?: () => void;
    onDisconnected?: () => void;
  }): void {
    this.onEvent = handlers.onEvent ?? null;
    this.onConnected = handlers.onConnected ?? null;
    this.onDisconnected = handlers.onDisconnected ?? null;
  }

  /** 建立 WS 连接（不阻塞；连上后通过 onConnected 通知） */
  connect(): void {
    this.stopped = false;
    this.wsCandidates = buildWsCandidates(this.wsUrl);
    this.wsCandidateIdx = 0;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.stopped) return;

    const headers: Record<string, string> = {};
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    const url = this.wsCandidates[this.wsCandidateIdx] ?? this.wsUrl;
    this.logger.info(`connecting ws ${url} ...`);
    const ws = new WebSocket(url, { headers });
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.logger.info('ws connected');
      this.onConnected?.();
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let ev: Ob11AnyEvent;
      try {
        ev = JSON.parse(raw.toString()) as Ob11AnyEvent;
      } catch {
        this.logger.warn('ws: non-JSON frame ignored');
        return;
      }
      // meta_event（心跳/lifecycle）不需要透传
      if (ev.post_type === 'meta_event') return;
      try {
        this.onEvent?.(ev);
      } catch (err) {
        this.logger.error(`event handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.error(`ws error: ${err.message}`);
    });

    ws.on('close', (code: number) => {
      this.logger.warn(`ws closed (code=${code})`);
      this.ws = null;
      this.onDisconnected?.();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;

    // 指数退避：3s, 6s, 12s, 24s, 30s 封顶
    const delay = Math.min(this.reconnectIntervalMs * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;
    this.logger.info(`reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /** 主动断开（不再重连） */
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

/** 按字符数分片（QQ 单条上限较宽松，但过长仍可能被拒；按段落边界切更自然） */
export function chunkText(text: string, limit: number): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 优先在换行处切
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
