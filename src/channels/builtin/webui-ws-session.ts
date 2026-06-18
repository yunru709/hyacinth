// ============================================================
// WebUIWsSession — WebSocket 会话管理
// ============================================================
//
// 每个浏览器标签页对应一个 WebUIWsSession：
//   - 维护一个 AgentLoop 实例
//   - 通过 WebUIOutputHandler 桥接输出
//   - 处理来自 WebSocket 的 ClientMessage
// ============================================================

import type { AgentFactory, ChannelMessageEvent, ReplyFn } from '../interface.js';
import type { WebUIClientMessage, WebUISessionConfig } from './webui-types.js';
import { WebUIOutputHandler } from './webui-output-handler.js';
import type { OutputHandler, TurnInfo } from '../../orchestrator/loop.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('webui-session');

/** WebSocket 最小接口（避免静态依赖 ws 库） */
export interface WsLike {
  send(data: string): void;
  readyState: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...args: any[]) => void): void;
}

export class WebUIWsSession {
  /** WebSocket 连接 ID（Map key，不变） */
  readonly sessionId: string;
  /** 当前活跃的 session（可切换） */
  private _activeSessionId: string;
  private ws: WsLike;
  private outputHandler: WebUIOutputHandler;
  private loop: import('../../orchestrator/loop.js').AgentLoop | null = null;
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private isProcessing = false;
  private createdAt: number;
  private config: WebUISessionConfig | null = null;
  private _onClose?: (sessionId: string) => void;
  /** 保存 agentFactory 引用，供 switchSession 使用 */
  private _agentFactory: AgentFactory | null = null;
  /** 初始化完成前缓冲的消息 */
  private _pendingMessages: WebUIClientMessage[] = [];

  constructor(ws: WsLike, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    this._activeSessionId = sessionId;
    this.outputHandler = new WebUIOutputHandler(ws);
    this.createdAt = Date.now();
  }

  /** 注册关闭回调 */
  onClose(cb: (sessionId: string) => void): void {
    this._onClose = cb;
  }

  /** 初始化 AgentLoop（在 agentFactory 可用后调用） */
  async initialize(
    agentFactory: AgentFactory,
    config: WebUISessionConfig,
  ): Promise<void> {
    this.config = config;
    this._agentFactory = agentFactory;

    // 保存 init Promise，handleMessage 可以用它来等待
    this._initPromise = (async () => {
      try {
        const result = await agentFactory.createAgent({
          sessionId: this.sessionId,
          outputHandler: this.outputHandler as OutputHandler,
        });
        this.loop = (result as { loop: import('../../orchestrator/loop.js').AgentLoop }).loop;
        this._initialized = true;

        // 发送连接成功消息
        this.send({
          type: 'connected',
          sessionId: this._activeSessionId,
          config: this.config!,
        });

        // 处理缓冲的消息
        const pending = this._pendingMessages.splice(0);
        if (pending.length > 0) {
          logger.info('Processing buffered messages', { count: pending.length, sessionId: this.sessionId });
          for (const msg of pending) {
            await this.dispatchMessage(msg);
          }
        }

        logger.info('WebUI session initialized', { sessionId: this.sessionId });
      } catch (err) {
        logger.error('Failed to initialize WebUI session', err instanceof Error ? err : new Error(String(err)), {
          sessionId: this.sessionId,
        });
        this.send({
          type: 'error',
          message: `Failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();

    return this._initPromise;
  }

  /** 处理来自客户端的消息 */
  async handleMessage(raw: Buffer): Promise<void> {
    let msg: WebUIClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as WebUIClientMessage;
    } catch {
      this.send({ type: 'error', message: 'Invalid JSON' });
      return;
    }

    // 尚未初始化完成：缓冲消息
    if (!this._initialized) {
      if (msg.type === 'chat') {
        this._pendingMessages.push(msg);
        this.send({
          type: 'status',
          message: 'Session is initializing, message queued...',
          level: 'info',
        });
        // 确保初始化已经开始
        if (!this._initPromise && this.config) {
          // config 已设置但未开始初始化 —— 不太可能，但兜底
        }
        return;
      }
      // stop / permission 即使在初始化期间也可以处理
      if (msg.type === 'permission') {
        this.outputHandler.resolvePermission(msg.result);
        return;
      }
      return;
    }

    await this.dispatchMessage(msg);
  }

  /** 分发已准备好的消息 */
  private async dispatchMessage(msg: WebUIClientMessage): Promise<void> {
    switch (msg.type) {
      case 'chat':
        await this.handleChat(msg.content, msg.images);
        break;

      case 'stop':
        this.handleStop();
        break;

      case 'permission':
        this.outputHandler.resolvePermission(msg.result);
        break;

      case 'set_mode':
        await this.handleSetMode(msg.mode);
        break;

      case 'rollback':
        await this.handleRollback(msg.toTurnId);
        break;

      case 'switch_session':
        await this.handleSwitchSession(msg.sessionId);
        break;

      default:
        logger.warn('Unknown WebUI client message type', {
          type: (msg as { type: string }).type,
          sessionId: this.sessionId,
        });
    }
  }

  /** 处理聊天消息 */
  private async handleChat(
    content: string,
    images?: Array<{ data: string; media_type: string }>,
  ): Promise<void> {
    if (!this._initialized || !this.loop) {
      this.send({ type: 'error', message: 'Session is still initializing. Please wait.' });
      return;
    }

    if (this.isProcessing) {
      this.send({
        type: 'status',
        message: 'Already processing a message. Use stop to interrupt.',
        level: 'warn',
      });
      return;
    }

    if (!content.trim()) return;

    this.isProcessing = true;

    try {
      // 注入图片（如果有）
      if (images?.length && (this.loop as any).channelImages !== undefined) {
        (this.loop as any).channelImages = images;
      }

      await this.loop.run(content);

      // 发送回合结束状态
      const turnInfo = this.getTurnInfo();
      if (turnInfo) {
        this.outputHandler.sendTurnInfo(turnInfo);
      }
    } catch (err) {
      logger.error('WebUI chat error', err instanceof Error ? err : new Error(String(err)), {
        sessionId: this.sessionId,
      });
      this.send({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isProcessing = false;
    }
  }

  /** 停止当前处理 */
  private handleStop(): void {
    // AgentLoop 的 interrupt 机制
    if (this.loop && typeof (this.loop as any).requestStop === 'function') {
      (this.loop as any).requestStop();
    }
  }

  /** 回滚到指定回合 */
  private async handleRollback(toTurnId: number): Promise<void> {
    if (!this.config?.cwd) {
      this.send({ type: 'error', message: 'No project directory configured' });
      return;
    }

    try {
      const path = await import('node:path');
      const { TurnStore } = await import('../../rollback/turn-store.js');
      const { GitManager } = await import('../../evolution/git-manager.js');

      const rollbackDir = path.join(this.config.cwd, '.agent', 'rollback');
      const turnStore = new TurnStore(rollbackDir);
      const gitManager = new GitManager(this.config.cwd);

      // 检查是否是 git 仓库
      if (!(await gitManager.isRepo())) {
        this.send({ type: 'error', message: 'Rollback requires a git repository' });
        return;
      }

      // 找到最近的 ≤ toTurnId 的记录
      const records = await turnStore.list();
      if (records.length === 0) {
        this.send({ type: 'error', message: 'No rollback history available' });
        return;
      }

      const targetRecord = records
        .filter(r => r.turnId <= toTurnId)
        .sort((a, b) => b.turnId - a.turnId)[0];

      if (!targetRecord) {
        this.send({
          type: 'error',
          message: `Turn ${toTurnId} not found in rollback history. Oldest: ${records[0]?.turnId}`,
        });
        return;
      }

      if (!targetRecord.preCommit) {
        this.send({ type: 'error', message: 'No git commit for target turn' });
        return;
      }

      // 执行回滚
      await gitManager.resetHard(targetRecord.preCommit);

      // 清理记录
      await turnStore.deleteRange(targetRecord.turnId + 1);

      // 清理 tag
      const rolledBackTurns = records.filter(r => r.turnId > targetRecord.turnId);
      for (const r of rolledBackTurns) {
        try { await gitManager.git(['tag', '-d', `rollback-turn-${r.turnId}`]); } catch {}
      }

      const fileList = rolledBackTurns
        .flatMap(r => r.changedFiles.map(f => f.path))
        .filter((v, i, a) => a.indexOf(v) === i);

      this.send({
        type: 'status',
        message: `↩ Rolled back to turn ${targetRecord.turnId}. ${fileList.length} file(s) restored.`,
        level: 'info',
      });

      logger.info('WebUI rollback executed', {
        sessionId: this.sessionId,
        toTurnId,
        targetTurn: targetRecord.turnId,
        filesRestored: fileList.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'error', message: `Rollback failed: ${msg}` });
      logger.error('WebUI rollback error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 处理 session 切换 */
  private async handleSwitchSession(sessionId: string): Promise<void> {
    if (!this._agentFactory || !this.config) {
      this.send({ type: 'error', message: 'Agent factory not available' });
      return;
    }
    await this.switchSession(sessionId, this._agentFactory);
  }

  /** 切换模式 */
  private async handleSetMode(mode: 'normal' | 'precise'): Promise<void> {
    if (!this.loop) return;

    try {
      if (mode === 'precise') {
        const { PreciseStrategy } = await import(
          '../../context/precision/index.js'
        );
        // 需要 sessionDir——从 loop 获取
        const sessionDir = (this.loop as any).sessionDir as string;
        if (sessionDir) {
          this.loop.composeStrategy = new PreciseStrategy(sessionDir);
        }
      } else {
        const { DefaultStrategy } = await import(
          '../../context/precision/index.js'
        );
        this.loop.composeStrategy = new DefaultStrategy();
      }
      this.send({
        type: 'status',
        message: `Mode set to ${mode}`,
        level: 'info',
      });
    } catch (err) {
      this.send({
        type: 'error',
        message: `Failed to set mode: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** 切换到另一个 session */
  async switchSession(
    newSessionId: string,
    agentFactory: AgentFactory,
  ): Promise<void> {
    if (newSessionId === this._activeSessionId) {
      this.send({
        type: 'status',
        message: `Already on session ${newSessionId.slice(0, 12)}...`,
        level: 'info',
      });
      return;
    }

    // 清理旧 loop
    if (this.loop && typeof (this.loop as any).requestStop === 'function') {
      (this.loop as any).requestStop();
    }
    this.loop = null;
    this._initialized = false;
    this._pendingMessages = [];

    try {
      const result = await agentFactory.createAgent({
        sessionId: newSessionId,
        outputHandler: this.outputHandler as OutputHandler,
      });
      this.loop = (result as { loop: import('../../orchestrator/loop.js').AgentLoop }).loop;
      this._activeSessionId = newSessionId;
      this._initialized = true;

      this.send({
        type: 'session_switched',
        sessionId: newSessionId,
      });

      logger.info('WebUI session switched', {
        wsId: this.sessionId,
        newSessionId,
      });
    } catch (err) {
      this.send({
        type: 'error',
        message: `Failed to switch session: ${err instanceof Error ? err.message : String(err)}`,
      });
      logger.error('WebUI session switch failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 获取当前回合信息 */
  private getTurnInfo(): TurnInfo | null {
    if (!this.loop) return null;
    try {
      return (
        this.loop as unknown as {
          getTurnInfo(turnCount: number, tokensUsed: number): TurnInfo;
        }
      ).getTurnInfo(
        (this.loop as unknown as { turnNumber: number }).turnNumber,
        0, // tokensUsed 在 loop 内部计算，外部估算
      );
    } catch {
      return null;
    }
  }

  /** 清理资源 */
  async close(): Promise<void> {
    logger.info('WebUI session closing', { sessionId: this.sessionId });
    this._onClose?.(this.sessionId);
    // AgentLoop 没有显式的 destroy 方法，由 GC 清理
    this.loop = null;
  }

  /** 发送消息到客户端 */
  private send(msg: Record<string, unknown>): void {
    if (this.ws.readyState === 1) {
      // WebSocket.OPEN
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        // 连接已断开
      }
    }
  }

  /** 获取存活时间（秒） */
  get aliveSeconds(): number {
    return Math.floor((Date.now() - this.createdAt) / 1000);
  }
}
