// ============================================================
// UI 协议层 — 传输适配器接口 + 进程内实现
// ============================================================
// UIAdapter 是协议层与具体传输（WS / InProc / 未来渠道）之间的
// 边界：任何实现都能接入协议服务器，UI 侧与后端均只依赖该接口。
//
// 语义对齐 WebSocket：
//   send(msg)         后端 → UI（协议服务器推送响应/事件）
//   onMessage(cb)     UI → 后端（客户端发来的请求/应答）
//   close()           断开连接
// ============================================================

import type { UiMessage } from './types.js';

/** 传输适配器接口 —— 协议服务器与具体传输之间的边界 */
export interface UIAdapter {
  /** 连接唯一 ID（用于日志与多连接区分） */
  readonly id: string;
  /** 向 UI 客户端发送一条协议消息（response / event） */
  send(message: UiMessage): void;
  /** 注册 UI 客户端消息处理器（request 等） */
  onMessage(handler: (message: UiMessage) => void): void;
  /** 断开连接并释放资源 */
  close(): void;
}

// ────────────────────────────────────────────────────────────
// InProcAdapter — 进程内双向内存交换
// ────────────────────────────────────────────────────────────
// 用于：TUI 等与后端同进程的 UI；以及协议层的单元测试。
// 两个 InProcAdapter 通过 connect() 建立双向链路，可互发消息。
// 同时记录 sent / received 消息数组，便于测试断言。
// ============================================================

export class InProcAdapter implements UIAdapter {
  readonly id: string;
  private peer: InProcAdapter | null = null;
  private handler: ((message: UiMessage) => void) | null = null;
  private _closed = false;

  /** 已发送的消息（测试/调试用） */
  readonly sent: UiMessage[] = [];
  /** 已接收的消息（测试/调试用） */
  readonly received: UiMessage[] = [];

  constructor(id: string) {
    this.id = id;
  }

  /** 与另一个 InProcAdapter 建立双向连接（两两互连） */
  connect(peer: InProcAdapter): void {
    this.peer = peer;
    peer.peer = this;
  }

  /** 向对端发送一条协议消息 */
  send(message: UiMessage): void {
    if (this._closed || !this.peer) return;
    this.sent.push(message);
    this.peer.deliver(message);
  }

  /** 注册消息处理器（从对端收到的消息） */
  onMessage(handler: (message: UiMessage) => void): void {
    this.handler = handler;
  }

  /** 从对端接收消息（内部调用） */
  private deliver(message: UiMessage): void {
    if (this._closed) return;
    this.received.push(message);
    if (this.handler) {
      try {
        this.handler(message);
      } catch (err) {
        // 处理器异常不应中断链路；交由上层处理
        // eslint-disable-next-line no-console
        console.error(`[ui-protocol] ${this.id} handler error:`, err);
      }
    }
  }

  /** 是否已断开 */
  get closed(): boolean {
    return this._closed;
  }

  /** 断开连接（双向解除） */
  close(): void {
    this._closed = true;
    if (this.peer) {
      this.peer.peer = null;
      this.peer = null;
    }
    this.handler = null;
  }
}

// ────────────────────────────────────────────────────────────
// 便捷工厂
// ────────────────────────────────────────────────────────────

/** 创建一对已互连的 InProcAdapter（返回 [client, server]） */
export function createInProcPair(
  clientId = 'ui-client',
  serverId = 'ui-server',
): [InProcAdapter, InProcAdapter] {
  const client = new InProcAdapter(clientId);
  const server = new InProcAdapter(serverId);
  client.connect(server);
  return [client, server];
}
