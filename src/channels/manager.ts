// ============================================================
// ChannelManager — 渠道生命周期管理器
// ============================================================
//
// 职责：
//   - 注册渠道（内置渠道 + 插件渠道）
//   - 启动/停止渠道
//   - 将渠道事件路由到消息处理器
//   - 将 Agent 回复发送回对应渠道
// ============================================================

import type {
  ChannelHandler,
  ChannelConfig,
  ChannelEvent,
  ChannelReply,
  ChannelState,
  ChannelStatus,
  AgentFactory,
  ReplyFn,
  ChannelMessageEvent,
} from './interface.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('channels');

export class ChannelManager {
  private channels = new Map<string, ChannelState>();
  private started = false;

  // ── 注册 ──────────────────────────────────────────────────

  /** 注册一个渠道处理器 */
  register(handler: ChannelHandler, config: ChannelConfig = {}): void {
    if (this.channels.has(handler.id)) {
      logger.warn('channel already registered, replacing', { id: handler.id });
    }
    this.channels.set(handler.id, {
      handler,
      status: 'registered',
      config,
    });
    logger.info('channel registered', { id: handler.id, name: handler.name });
  }

  /** 批量注册 */
  registerAll(entries: Array<{ handler: ChannelHandler; config?: ChannelConfig }>): void {
    for (const { handler, config } of entries) {
      this.register(handler, config);
    }
  }

  /** 获取所有已注册渠道 */
  getAll(): ChannelState[] {
    return [...this.channels.values()];
  }

  /** 获取指定渠道 */
  get(id: string): ChannelState | undefined {
    return this.channels.get(id);
  }

  /** 获取活跃渠道 */
  getActive(): ChannelState[] {
    return this.getAll().filter((c) => c.status === 'active');
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /**
   * 启动所有启用的渠道
   * 每个渠道自行处理消息（通过 handler.handleMessage）
   */
  async startAll(
    agentFactory: AgentFactory,
    enabledIds?: string[],
  ): Promise<void> {
    const toStart = this.getAll().filter((c) => {
      if (enabledIds && !enabledIds.includes(c.handler.id)) return false;
      return c.config.enabled !== false;
    });

    logger.info('starting channels', { count: toStart.length });

    for (const state of toStart) {
      await this.startChannel(state, agentFactory);
    }

    this.started = true;
  }

  /** 启动单个渠道 */
  async startChannel(state: ChannelState, agentFactory: AgentFactory): Promise<void> {
    const { handler, config } = state;

    try {
      state.status = 'starting';

      // 将 agentFactory 注入到渠道配置中（WebUI 等渠道需要它来创建 AgentLoop）
      (config as Record<string, unknown>).agentFactory = agentFactory;

      // 设置事件处理：渠道收到消息 → 调用 handler.handleMessage
      handler.onEvent(async (event: ChannelEvent) => {
        if (event.type === 'message') {
          const msgEvent = event as ChannelMessageEvent;
          const replyFn: ReplyFn = async (reply: ChannelReply) => {
            await handler.reply(msgEvent.sessionId, reply);
          };
          try {
            await handler.handleMessage(msgEvent, replyFn, agentFactory);
          } catch (err) {
            logger.error('handleMessage error', err instanceof Error ? err : new Error(String(err)), {
              channel: handler.id,
            });
          }
        }
      });

      await handler.start(config);
      state.status = 'active';
      logger.info('channel started', { id: handler.id });
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      logger.error('channel start failed', error instanceof Error ? error : new Error(state.error), {
        id: handler.id,
      });
    }
  }

  /** 停止所有渠道 */
  async stopAll(): Promise<void> {
    for (const state of this.getActive()) {
      await this.stopChannel(state);
    }
    this.started = false;
  }

  /** 停止单个渠道 */
  async stopChannel(state: ChannelState): Promise<void> {
    try {
      await state.handler.stop();
      state.status = 'stopped';
      logger.info('channel stopped', { id: state.handler.id });
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      logger.error('channel stop failed', error instanceof Error ? error : new Error(state.error), {
        id: state.handler.id,
      });
    }
  }

  /** 重启指定渠道 */
  async restart(id: string, agentFactory: AgentFactory): Promise<void> {
    const state = this.channels.get(id);
    if (!state) throw new Error(`Channel "${id}" not found`);

    if (state.status === 'active') {
      await this.stopChannel(state);
    }
    await this.startChannel(state, agentFactory);
  }

  // ── 主动发送 ──────────────────────────────────────────────

  /**
   * 通过指定渠道主动发送消息
   */
  async send(channelId: string, sessionId: string, reply: ChannelReply): Promise<void> {
    const state = this.channels.get(channelId);
    if (!state || state.status !== 'active') {
      throw new Error(`Channel "${channelId}" is not active`);
    }
    await state.handler.reply(sessionId, reply);
  }

  // ── 状态查询 ──────────────────────────────────────────────

  getStatusSummary(): Array<{ id: string; name: string; status: ChannelStatus }> {
    return this.getAll().map((c) => ({
      id: c.handler.id,
      name: c.handler.name,
      status: c.status,
    }));
  }

  /** 是否已启动 */
  isStarted(): boolean {
    return this.started;
  }
}