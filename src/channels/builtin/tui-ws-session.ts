// ============================================================
// TuiWsSession — TUI over WebSocket 会话管理
// ============================================================
//
// 当 TUI 客户端通过 WebSocket 连接到 serve 后端时使用。
// 与 WebUIWsSession 结构相同，专用于 TUI 渠道。
// ============================================================

import type { AgentFactory } from '../interface.js';
import { WebUIOutputHandler } from './webui-output-handler.js';
import type { OutputHandler } from '../../orchestrator/loop.js';
import type { WsLike } from './webui-ws-session.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('tui-ws-session');

interface TuiClientMessage {
  type: 'chat' | 'stop' | 'permission';
  content?: string;
  result?: 'yes' | 'no' | 'always';
}

export class TuiWsSession {
  readonly sessionId: string;
  private ws: WsLike;
  private outputHandler: WebUIOutputHandler;
  private loop: import('../../orchestrator/loop.js').AgentLoop | null = null;
  private _initialized = false;
  private isProcessing = false;

  constructor(ws: WsLike, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.outputHandler = new WebUIOutputHandler(ws);
  }

  async initialize(agentFactory: AgentFactory): Promise<void> {
    try {
      const result = await agentFactory.createAgent({
        sessionId: this.sessionId,
        outputHandler: this.outputHandler as OutputHandler,
      });
      this.loop = (result as { loop: import('../../orchestrator/loop.js').AgentLoop }).loop;
      this._initialized = true;

      this.send({ type: 'connected', sessionId: this.sessionId });
      logger.info('TUI WS session initialized', { sessionId: this.sessionId });
    } catch (err) {
      logger.error('TUI WS session init failed', err instanceof Error ? err : new Error(String(err)));
      this.send({ type: 'error', message: `Init failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async handleMessage(raw: Buffer): Promise<void> {
    let msg: TuiClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!this._initialized) { this.send({ type: 'error', message: 'Initializing...' }); return; }

    switch (msg.type) {
      case 'chat':
        if (!msg.content?.trim() || !this.loop || this.isProcessing) return;
        this.isProcessing = true;
        try {
          await this.loop.run(msg.content);
          const turnInfo = (this.loop as unknown as { getTurnInfo(t: number, u: number): unknown }).getTurnInfo(
            (this.loop as unknown as { turnNumber: number }).turnNumber, 0,
          );
          this.send({ type: 'turn_info', ...(turnInfo as Record<string, unknown>) });
        } catch (err) {
          this.send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        } finally {
          this.isProcessing = false;
        }
        break;

      case 'stop':
        if (this.loop && typeof (this.loop as any).requestStop === 'function') {
          (this.loop as any).requestStop();
        }
        break;

      case 'permission':
        this.outputHandler.resolvePermission(msg.result ?? 'no');
        break;
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); } catch {}
    }
  }

  async close(): Promise<void> {
    this.loop = null;
  }
}
