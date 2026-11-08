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

/**
 * 构造 WS 候选地址列表（双栈回退）。
 *
 * 背景（2026-11-08 实测）：NapCat 的 websocketServers 配 `host:0.0.0.0`，
 * 但实际 `ss -ltn` 显示绑定为 `*:3001`（IPv6 通配），而 HTTP 侧是 `0.0.0.0:3000`。
 * WSL2 的 localhost 转发只映射 IPv4 通配绑定 ⇒ Windows 侧连 127.0.0.1:3001
 * 得到 ECONNREFUSED；连 [::1]:3001 才行。
 *
 * 因此：当 URL 的主机是 127.0.0.1 / localhost 时，追加 IPv6 loopback 作为
 * 第二候选。这样用户不必知道 NapCat 绑到了哪个地址族。
 */
export function buildWsCandidates(wsUrl: string): string[] {
  const out: string[] = [wsUrl];
  try {
    const u = new URL(wsUrl);
    const host = u.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0') {
      const alt = new URL(wsUrl);
      alt.hostname = '[::1]';
      const altStr = alt.toString();
      if (altStr !== wsUrl) out.push(altStr);
    }
  } catch {
    // URL 解析失败就只用原值（让上层报连接错误，信息更直白）
  }
  return out;
}

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
      // 双栈回退：连不上就换下一个候选地址，而不是立刻退避。
      //
      // 为什么必须有这段：NapCat 的 websocketServers 配 host:0.0.0.0，实际绑成
      // `*:3001`（IPv6 通配），而 WSL2 的 localhost 转发只映射 IPv4 通配 ⇒
      // Windows 侧 127.0.0.1:3001 得到 ECONNREFUSED，只有 [::1]:3001 能连。
      // 没有这段切换，候选列表就是摆设，永远卡在第一个地址上退避重试。
      //
      // 只在「尚未成功连过」时切换（reconnectAttempts===0）——已连上后断开
      // 属于后端重启，应原地重连原地址，不该漂移。
      if (this.reconnectAttempts === 0 && this.wsCandidateIdx < this.wsCandidates.length - 1) {
        this.wsCandidateIdx += 1;
        this.logger.info(`switch ws candidate -> ${this.wsCandidates[this.wsCandidateIdx]}`);
        this.openSocket();
        return;
      }
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

/**
 * Markdown → 纯文本。
 *
 * 【为什么需要】QQ 客户端**不渲染 Markdown**：`**粗体**`、`## 标题`、``` 围栏、
 * `| 表格 |` 全部原样显示 —— 用户看到的是满屏星号井号和竖线。2026-11-08 孑遗
 * 明确要求「QQ 上发信息别用 .md」后加此层。
 *
 * 【为什么放在渠道层而不是只靠提示词】模型输出不可控（子 Agent、定时推送、
 * 跨渠道转发的文本都会落到这里）。渠道出口是唯一能把"渲染假设"兜住的地方，
 * 类比：WebUI 渲染 markdown，QQ 必须降级成纯文本 —— 这是传输格式适配，不是
 * 风格偏好。提示词只是第一道，这里是最后一道。
 *
 * 【规则保守】只处理**成对出现**的标记，宁可漏转绝不误删正文：
 *   - 代码围栏 → 保留代码内容（只去 ```lang 与收尾 ```）
 *   - 行内代码 → 去反引号
 *   - 标题 / 引用 / 分隔线 → 去符号，文字留
 *   - 列表 - * + → 统一 `· `（QQ 里 `-` 和正文容易混）
 *   - 表格 → 删分隔行，`|` 缩成两空格
 *   - 链接 [文案](url) → 文案（url）
 *   - 粗体/斜体/删除线 → 去符号
 *   - **单下划线强调不处理**：中文语境里 snake_case / 文件名 / 变量名里的 `_`
 *     远多于真强调，误伤代价大于收益。
 */
export function stripMarkdown(text: string): string {
  if (!text) return '';
  let s = text.replace(/\r\n/g, '\n');

  // ① 代码围栏：```lang ... ``` → 内容（去围栏与语言标记）
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => String(code).replace(/\n+$/, ''));

  // ② 表格分隔行（|---|---|）整行删
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, '');

  // ③ 表格行：| a | b | → a  b（| 变空格，丢空单元格）
  s = s.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) =>
    String(row).split('|').map((c) => c.trim()).filter((c) => c !== '').join('  '));

  // ④ 标题：### foo → foo
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');

  // ⑤ 分隔线 --- / *** / ___
  s = s.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');

  // ⑥ 引用 >
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');

  // ⑦ 列表标记统一成 ·
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1· ');

  // ⑧ 链接 / 图片：[文案](url) → 文案（url）；![alt](url) → alt（url）
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    (label ? `${label}（${url}）` : url));

  // ⑨ 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');

  // ⑩ 粗体 / 斜体 / 删除线（成对才转；`***x***` 先处理）
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1$2');
  s = s.replace(/___([^_\n]+)___/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/~~([^~\n]+)~~/g, '$1');

  // ⑪ 收尾：3+ 连空行压成 2
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
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
