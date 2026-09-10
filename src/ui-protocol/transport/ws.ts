// ============================================================
// UI 协议层 — WebSocket 传输适配器
// ============================================================
// WsAdapter：将一条 WebSocket 连接封装成 UIAdapter，让协议
// 服务器通过 WS 服务远程 UI（WebUI / 桌面端 / 未来渠道）。
//
// 职责：
//  1. JSON 编解码：UiMessage ⇄ 文本帧
//  2. ping/pong 心跳：定时探测连接活性，失联自动关闭
//  3. 断线清理：close / error / 心跳超时 → 释放资源
//
// attachWsUpgrade：在 http.Server 的 upgrade 事件上挂载
// <path> 端点，为每个连接创建 WsAdapter 并接入协议服务器。
// ============================================================

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { UIAdapter } from '../adapter.js';
import type { UiMessage } from '../types.js';
import type { UiProtocolServer } from '../server.js';

// ────────────────────────────────────────────────────────────
// WsAdapter
// ────────────────────────────────────────────────────────────

export interface WsAdapterOptions {
  /** 连接唯一 ID（默认自动生成） */
  id?: string;
  /** ping 间隔（ms）。0 或缺省表示关闭心跳。默认 30000。 */
  pingIntervalMs?: number;
  /** pong 超时（ms）。超过视为失联。默认 10000。 */
  pongTimeoutMs?: number;
}

export class WsAdapter implements UIAdapter {
  readonly id: string;
  private ws: WebSocket;
  private handler: ((message: UiMessage) => void) | null = null;
  private _closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private isAlive = true;

  /** 全局连接计数器（供外部生成唯一 id） */
  static idCounter = 0;

  constructor(ws: WebSocket, options: WsAdapterOptions = {}) {
    this.ws = ws;
    this.id =
      options.id ??
      `ws_${Date.now().toString(36)}_${(WsAdapter.idCounter++).toString(36)}`;

    // 二进制帧统一按 UTF-8 文本解析（协议消息均为 JSON）
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      this.handleRaw(data);
    });
    ws.on('close', () => this.cleanup());
    ws.on('error', () => this.cleanup());
    ws.on('pong', () => {
      this.isAlive = true;
    });

    // 心跳
    const interval = options.pingIntervalMs ?? 30000;
    if (interval > 0) {
      this.pingTimer = setInterval(() => {
        if (this._closed) return;
        if (!this.isAlive) {
          // 上次 ping 未收到 pong → 失联
          this.cleanup();
          try { this.ws.terminate(); } catch { /* ignore */ }
          return;
        }
        this.isAlive = false;
        try { this.ws.ping(); } catch { /* ignore */ }
        // 设置 pong 超时兜底
        const pongTimeout = options.pongTimeoutMs ?? 10000;
        this.pongTimer = setTimeout(() => {
          if (!this.isAlive && !this._closed) {
            this.cleanup();
            try { this.ws.terminate(); } catch { /* ignore */ }
          }
        }, pongTimeout);
      }, interval);
      // 不阻止进程退出
      this.pingTimer.unref?.();
    }
  }

  /** 解析收到的帧（Buffer / ArrayBuffer / Buffer[]）为 UiMessage */
  private handleRaw(data: Buffer | ArrayBuffer | Buffer[]): void {
    if (this._closed) return;
    let text: string;
    if (Array.isArray(data)) {
      text = Buffer.concat(data).toString('utf-8');
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString('utf-8');
    } else {
      text = data.toString('utf-8');
    }
    if (!text) return;
    try {
      const msg = JSON.parse(text) as UiMessage;
      if (msg && typeof msg === 'object' && 'kind' in msg) {
        this.handler?.(msg);
      }
    } catch {
      // 忽略无法解析的消息
    }
  }

  send(message: UiMessage): void {
    if (this._closed || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      // 发送失败（连接异常）→ 触发清理
      this.cleanup();
    }
  }

  onMessage(handler: (message: UiMessage) => void): void {
    this.handler = handler;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** 底层 WS 就绪状态（测试用） */
  get readyState(): number {
    return this.ws.readyState;
  }

  /** 断开连接（优雅关闭） */
  close(): void {
    this.cleanup();
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    } catch { /* ignore */ }
  }

  /** 释放内部资源（幂等） */
  private cleanup(): void {
    if (this._closed) return;
    this._closed = true;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    this.handler = null;
  }
}

// ────────────────────────────────────────────────────────────
// attachWsUpgrade — 在 http.Server 上挂载协议 WS 端点
// ────────────────────────────────────────────────────────────

export interface AttachWsOptions {
  /** 挂载路径（如 '/ui'）。upgrade 请求 URL 匹配此路径才接管。 */
  path: string;
  /** 协议服务器（每个连接 attach 上去） */
  protocolServer: UiProtocolServer;
  /** 连接 ID 前缀（可选） */
  idPrefix?: string;
  /** ping 间隔（ms）。默认 30000。 */
  pingIntervalMs?: number;
  /** pong 超时（ms）。默认 10000。 */
  pongTimeoutMs?: number;
  /** upgrade 请求鉴权钩子：返回 false 拒绝连接（可选） */
  authorize?: (request: IncomingMessage) => boolean;
}

/**
 * 在 http.Server 的 upgrade 事件上挂载一个 WebSocket 协议端点。
 * 匹配 <path> 的连接会被升级为 WsAdapter 并 attach 到协议服务器。
 * @returns 内部 WebSocketServer（供测试/关闭用）
 */
export function attachWsUpgrade(
  httpServer: HttpServer,
  options: AttachWsOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const idPrefix = options.idPrefix ?? 'ws';
  const protocolServer = options.protocolServer;

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = (request.url ?? '').split('?')[0];
    if (url !== options.path) return; // 不接管，留给其他端点
    if (options.authorize && !options.authorize(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const adapter = new WsAdapter(ws, {
      id: `${idPrefix}_${Date.now().toString(36)}_${(WsAdapter.idCounter++).toString(36)}`,
      pingIntervalMs: options.pingIntervalMs,
      pongTimeoutMs: options.pongTimeoutMs,
    });
    // 连接断开时从协议服务器移除
    ws.on('close', () => {
      protocolServer.detach(adapter);
    });
    protocolServer.attach(adapter);
  });

  return wss;
}
