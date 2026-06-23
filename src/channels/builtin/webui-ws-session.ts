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
import type { SessionManager } from '../../memory/session.js';
import { createLogger } from '../../logging/logger.js';
import { MessageQueue, QueueMessageMode } from '../message-queue.js';
import { RuntimeConfigCenter } from '../../runtime/config-center.js';

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
  /** 切换代数（防止并发切换） */
  private _switchGeneration = 0;
  /** 初始化完成前缓冲的消息 */
  private _pendingMessages: WebUIClientMessage[] = [];
  /** WebUI 当前模式 */
  private _mode: 'normal' | 'precise' = 'normal';
  /** 进入 precise 前的 normal session，用于切回 */
  private _normalSessionId: string;
  /** WebSocket 首次初始化时的 normal session， precise → normal 时切回 */
  private _originalNormalSessionId: string;
  /** 注入的 SessionManager（避免多实例） */
  private _sessionManager: SessionManager | null = null;
  /** 消息队列（类似 TUI 的排队/插队） */
  private messageQueue = new MessageQueue();
  /** 带 ID 的队列项（前端显示/移除需要 id） */
  private queueItems: Array<{ id: string; text: string; mode: QueueMessageMode }> = [];
  /** 队列是否正在消费 */
  private queueConsuming = false;
  private nextQueueItemId = 0;

  constructor(ws: WsLike, sessionId: string, sessionManager?: SessionManager) {
    this.ws = ws;
    this.sessionId = sessionId;
    this._activeSessionId = sessionId;
    this._normalSessionId = sessionId;
    this._originalNormalSessionId = sessionId;
    this.outputHandler = new WebUIOutputHandler(ws);
    this.createdAt = Date.now();
    this._sessionManager = sessionManager ?? null;
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
          channel: 'webui',
        });
        this.loop = (result as { loop: import('../../orchestrator/loop.js').AgentLoop }).loop;
        this._initialized = true;

        // 发送连接成功消息
        this.send({
          type: 'connected',
          sessionId: this._activeSessionId,
          mode: this._mode,
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
        return;
      }
      // stop / permission / switch_session 即使在初始化期间也可以处理
      if (msg.type === 'permission') {
        this.outputHandler.resolvePermission(msg.result);
        return;
      }
      if (msg.type === 'switch_session') {
        // 直接处理，不缓冲（会中断当前初始化并重新开始）
        await this.handleSwitchSession(msg.sessionId);
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

      case 'switch_provider':
        await this.handleSwitchProvider(msg.provider);
        break;

      case 'switch_model':
        await this.handleSwitchModel(msg.model);
        break;

      case 'queue_message':
      case 'queue_insert':
        await this.handleQueueMessage(msg.type, msg.content);
        break;

      case 'queue_remove':
        this.handleQueueRemove(msg.id);
        break;

      case 'queue_clear':
        this.handleQueueClear();
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

    if (!content.trim()) return;

    if (this.isProcessing) {
      const id = this.addQueueItem(content, QueueMessageMode.Queue);
      this.sendQueueUpdate();
      this.send({
        type: 'status',
        message: `Agent 正在处理，消息已加入队列 (#${id})`,
        level: 'info',
      });
      return;
    }

    await this.runChat(content, images);
  }

  private async runChat(
    content: string,
    images?: Array<{ data: string; media_type: string }>,
  ): Promise<void> {
    if (!this.loop) return;

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
      // 消费队列中的下一条消息
      setTimeout(() => this.consumeQueue(), 0);
    }
  }

  /** 消费队列中的下一条消息 */
  private consumeQueue(): void {
    if (this.queueConsuming || this.isProcessing || !this.loop) return;
    const next = this.shiftQueueItem();
    if (!next) return;
    this.queueConsuming = true;
    this.sendQueueUpdate();
    this.runChat(next.text)
      .finally(() => {
        this.queueConsuming = false;
        setTimeout(() => this.consumeQueue(), 0);
      });
  }

  private addQueueItem(text: string, mode: QueueMessageMode): string {
    const id = `q-${++this.nextQueueItemId}`;
    this.messageQueue.enqueue(text, mode);
    this.queueItems.push({ id, text, mode });
    if (this.queueItems.length > MessageQueue.MAX_QUEUE_SIZE) {
      this.queueItems.shift();
    }
    return id;
  }

  private shiftQueueItem(): { text: string; mode: QueueMessageMode } | undefined {
    const item = this.messageQueue.dequeue();
    this.queueItems.shift();
    return item ? { text: item.text, mode: item.mode } : undefined;
  }

  /** 发送队列状态更新 */
  private sendQueueUpdate(): void {
    const items = this.queueItems.map((m) => ({
      id: m.id,
      content: m.text,
      mode: m.mode === QueueMessageMode.Insert ? 'insert' as const : 'queue' as const,
    }));
    this.send({ type: 'queue_updated', items });
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
      const os = await import('node:os');
      const { TurnStore } = await import('../../rollback/turn-store.js');
      const { GitManager } = await import('../../evolution/git-manager.js');

      const rollbackDir = path.join(os.homedir(), '.agent', 'rollback');
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

  /** 切换 Provider */
  private async handleSwitchProvider(provider: string): Promise<void> {
    if (!this.loop) {
      this.send({ type: 'error', message: 'Agent loop not available' });
      return;
    }
    try {
      await this.loop.switchProvider(provider);
      const cfg = RuntimeConfigCenter.getInstance();
      cfg.set('provider.active', provider);
      cfg.save().catch(() => {});
      const activeProvider = this.loop.getActiveProvider();
      this.send({
        type: 'model_status',
        provider: activeProvider.getProviderType(),
        model: activeProvider.getModel(),
      });
      this.send({
        type: 'status',
        message: `已切换到 provider: ${activeProvider.getProviderType()}`,
        level: 'success',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'error', message: `切换 Provider 失败: ${msg}` });
    }
  }

  /** 切换 Model */
  private async handleSwitchModel(model: string): Promise<void> {
    if (!this.loop) {
      this.send({ type: 'error', message: 'Agent loop not available' });
      return;
    }
    try {
      const activeProvider = this.loop.getActiveProvider();
      const providerType = activeProvider.getProviderType();
      const cfg = RuntimeConfigCenter.getInstance();
      cfg.set(`provider.${providerType}.model`, model);
      cfg.save().catch(() => {});
      this.send({
        type: 'model_status',
        provider: providerType,
        model,
      });
      this.send({
        type: 'status',
        message: `已设置模型: ${model}（provider: ${providerType}）`,
        level: 'success',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ type: 'error', message: `切换模型失败: ${msg}` });
    }
  }

  /** 处理队列消息 */
  private handleQueueMessage(
    type: 'queue_message' | 'queue_insert',
    content: string,
  ): void {
    const isInsert = type === 'queue_insert';
    const mode = isInsert ? QueueMessageMode.Insert : QueueMessageMode.Queue;
    const id = this.addQueueItem(content, mode);
    if (isInsert) {
      if (this.isProcessing && this.loop && typeof (this.loop as any).requestStop === 'function') {
        (this.loop as any).requestStop();
      }
      this.send({
        type: 'status',
        message: `消息已插队 (#${id})，当前处理将被中断`,
        level: 'info',
      });
    } else {
      this.send({
        type: 'status',
        message: `消息已加入队列 (#${id})`,
        level: 'info',
      });
    }
    this.sendQueueUpdate();
    setTimeout(() => this.consumeQueue(), 0);
  }

  /** 移除队列中的消息 */
  private handleQueueRemove(id: string): void {
    const index = this.queueItems.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.queueItems.splice(index, 1);
      this.messageQueue.removeAt(index);
    }
    this.sendQueueUpdate();
  }

  /** 清空队列 */
  private handleQueueClear(): void {
    this.messageQueue.clear();
    this.queueItems = [];
    this.sendQueueUpdate();
  }

  /** 切换模式 */
  private async handleSetMode(mode: 'normal' | 'precise'): Promise<void> {
    if (!this.loop || !this.config?.cwd) {
      this.send({ type: 'error', message: 'Agent loop not available' });
      return;
    }

    if (mode === this._mode) {
      this.send({
        type: 'status',
        message: `Already in ${mode} mode`,
        level: 'info',
        mode,
        sessionId: this._activeSessionId,
      });
      return;
    }

    try {
      const sessionManager = this._sessionManager!;

      if (mode === 'precise') {
        const sessions = await sessionManager.list();
        const existingPrecise = sessions.find((s) => s.type === 'precise' && s.channel === 'webui');
        const newSession = existingPrecise ?? (await sessionManager.create('precise', 'webui'));
        const newSessionDir = sessionManager.getSessionDir(newSession.id);

        const { PreciseStrategy } = await import('../../context/precision/index.js');
        this.loop.composeStrategy = new PreciseStrategy(newSessionDir);
        await this.loop.switchSession(newSessionDir);

        this._activeSessionId = newSession.id;
        this._mode = 'precise';
      } else {
        const { DefaultStrategy } = await import('../../context/precision/index.js');
        this.loop.composeStrategy = new DefaultStrategy();

        const originalSessionDir = sessionManager.getSessionDir(this._originalNormalSessionId);
        await this.loop.switchSession(originalSessionDir);

        this._activeSessionId = this._originalNormalSessionId;
        this._mode = 'normal';
      }

      this.send({
        type: 'session_switched',
        sessionId: this._activeSessionId,
        mode: this._mode,
      });

      logger.info('WebUI mode switched', {
        wsId: this.sessionId,
        mode: this._mode,
        activeSessionId: this._activeSessionId,
      });
    } catch (err) {
      this.send({
        type: 'error',
        message: `Failed to set mode: ${err instanceof Error ? err.message : String(err)}`,
      });
      logger.error('WebUI mode switch failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async getSessionForMode(mode: 'normal' | 'precise'): Promise<string> {
    const sessionManager = this._sessionManager!;
    const sessions = await sessionManager.list();

    if (mode === 'precise') {
      if (this._mode === 'normal') {
        this._normalSessionId = this._activeSessionId;
      }
      const existingPrecise = sessions.find(s => s.type === 'precise' && s.channel === 'webui');
      return existingPrecise?.id ?? (await sessionManager.create('precise', 'webui')).id;
    }

    const currentNormal = sessions.find(s => s.id === this._normalSessionId && (s.type ?? 'normal') === 'normal');
    return currentNormal?.id ?? (await sessionManager.create('normal', 'webui')).id;
  }

  private async getModeForSession(sessionId: string): Promise<'normal' | 'precise'> {
    const sessionManager = this._sessionManager!;
    const session = await sessionManager.resume(sessionId);
    return session.type === 'precise' ? 'precise' : 'normal';
  }

  /** 切换到另一个 session */
  async switchSession(
    newSessionId: string,
    agentFactory: AgentFactory,
    mode?: 'normal' | 'precise',
  ): Promise<void> {
    if (newSessionId === this._activeSessionId) {
      if (mode) this._mode = mode;
      this.send({
        type: 'status',
        message: `Already on session ${newSessionId.slice(0, 12)}...`,
        level: 'info',
        mode: this._mode,
        sessionId: this._activeSessionId,
      });
      return;
    }

    const gen = ++this._switchGeneration;

    // 清理旧 loop
    if (this.loop && typeof (this.loop as any).requestStop === 'function') {
      (this.loop as any).requestStop();
    }
    this.loop = null;
    this._initialized = false;
    this.isProcessing = false;
    this._pendingMessages = [];

    try {
      const result = await agentFactory.createAgent({
        sessionId: newSessionId,
        outputHandler: this.outputHandler as OutputHandler,
        channel: 'webui',
      });

      // 如果在此期间又发起了新的切换，放弃本次结果
      if (this._switchGeneration !== gen) {
        logger.info('WebUI session switch superseded', {
          wsId: this.sessionId,
          newSessionId,
          generation: gen,
          current: this._switchGeneration,
        });
        return;
      }

      this.loop = (result as { loop: import('../../orchestrator/loop.js').AgentLoop }).loop;
      this._activeSessionId = newSessionId;
      this._mode = mode ?? await this.getModeForSession(newSessionId);
      if (this._mode === 'normal') {
        this._normalSessionId = newSessionId;
      }
      this._initialized = true;

      this.send({
        type: 'session_switched',
        sessionId: newSessionId,
        mode: this._mode,
      });

      logger.info('WebUI session switched', {
        wsId: this.sessionId,
        newSessionId,
      });
    } catch (err) {
      // 如果已被取代，不发送错误消息
      if (this._switchGeneration !== gen) return;

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

  /** 通知当前 loop 执行定时任务（由 WebUIChannel 调度器转发调用） */
  async notifyTask(taskName: string): Promise<void> {
    if (!this.loop) {
      throw new Error('Agent loop not initialized');
    }
    await this.loop.notifyTaskFired(taskName);
  }
}
