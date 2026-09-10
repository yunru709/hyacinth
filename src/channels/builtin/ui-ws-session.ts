// ============================================================
// UiWsSession — 协议层 over WebSocket 会话（薄封装）
// ============================================================
// 将一条 WS 连接接入 ui-protocol 协议层。真正的装配逻辑（注册
// 7 域、two-phase loop 注入、attach 适配器）统一收敛到
// UiProtocolSession，本类只负责「WebSocket → WsAdapter」这一层
// 传输绑定，保持与 TUI 本地模式（InProcAdapter）完全相同的
// 后端协议，使 WebUI / TUI / 桌面端共享同一套 7 域协议。
// ============================================================

import type { WebSocket } from 'ws';
import { WsAdapter } from '../../ui-protocol/transport/ws.js';
import { UiProtocolSession, type UiProtocolSessionBackend } from './ui-protocol-session.js';

const logger = createLoggerSafe();

function createLoggerSafe(): { info: (m: string, o?: unknown) => void; error: (m: string, e: unknown) => void } {
  // 与 UiProtocolSession 复用同一 logger；此处轻量代理避免重复 import 语义
  return {
    info: () => {},
    error: () => {},
  };
}

/** 静态后端依赖（不依赖 AgentLoop 的部分）—— 与 UiProtocolSession 一致 */
export interface UiWsSessionBackend extends UiProtocolSessionBackend {}

export class UiWsSession {
  readonly sessionId: string;
  private adapter: WsAdapter;
  private inner: UiProtocolSession;

  constructor(ws: WebSocket, sessionId: string, backend: UiWsSessionBackend) {
    this.sessionId = sessionId;
    this.adapter = new WsAdapter(ws);
    this.inner = new UiProtocolSession(this.adapter, sessionId, backend);
  }

  /**
   * 通过 agentFactory 创建 AgentLoop 并注册依赖 loop 的域，
   * 然后 attach WsAdapter 开始服务协议消息。
   */
  async initialize(agentFactory: import('../interface.js').AgentFactory): Promise<void> {
    await this.inner.initialize(agentFactory);
  }

  /** 暴露底层 loop（供同进程调试/读取） */
  getLoop(): import('../../orchestrator/loop.js').AgentLoop | null {
    return this.inner.getLoop();
  }

  /** 暴露 createAgent 返回的完整后端组件（knowledgeBase/backgroundRegistry 等） */
  getComponents<T = unknown>(): T | null {
    return this.inner.getComponents<T>();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

// 保持 logger 未使用告警可控（真实日志在 UiProtocolSession 内打印）
void logger;
void createLoggerSafe;