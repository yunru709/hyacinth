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
  ChannelMessageEvent,
  ChannelLoopEntry,
  ChannelLoopCapabilities,
  ChannelOutputHandler,
} from './interface.js';
import type { SessionService } from '../session-service.js';
import { createLogger } from '../logging/logger.js';
import { registerChannelPrefixes, unregisterChannelPrefixes } from '../session-channel.js';

const logger = createLogger('channels');

export class ChannelManager {
  private channels = new Map<string, ChannelState>();
  private started = false;
  /** 内核会话服务（startAll 注入）；空 = 未接线（渠道只做转发，不参与编排） */
  private sessionService: SessionService | null = null;

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
    // 渠道声明了 session 前缀 → 自动登记到前缀→渠道表（sessionId 推断渠道用）。
    // 支持多前缀（如 WebUI 的 webui_ + 旧版 ui_）：string | readonly string[]。
    // 映射目标是**会话归属渠道名**（sessionChannel，缺省 = handler id）—— 必须与
    // 创建 Agent 时传的 channel 选项一致，否则「按渠道恢复最近会话」匹配不上。
    if (handler.sessionPrefix) {
      const channelName = handler.sessionChannel ?? handler.id;
      registerChannelPrefixes(handler.sessionPrefix, channelName);
      logger.debug('registered channel session prefix', { id: handler.id, channel: channelName, prefix: handler.sessionPrefix });
    }
    logger.info('channel registered', { id: handler.id, name: handler.name });
  }

  /** 取消注册一个渠道（插件卸载时调用） */
  unregister(id: string): boolean {
    const state = this.channels.get(id);
    const existed = this.channels.delete(id);
    if (existed && state?.handler.sessionPrefix) {
      unregisterChannelPrefixes(state.handler.sessionPrefix);
      logger.debug('unregistered channel session prefix', { id, prefix: state.handler.sessionPrefix });
    }
    if (existed) logger.info('channel unregistered', { id });
    return existed;
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
   * 消息编排（resolve → loop.run → reply）由内核 SessionService 统一完成。
   */
  async startAll(
    agentFactory: AgentFactory,
    sessionService?: SessionService,
    enabledIds?: string[],
  ): Promise<void> {
    this.sessionService = sessionService ?? null;
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

      // 将 agentFactory 注入到渠道配置中（WebUI/HTTP 等**直连装配**渠道需要它创建 AgentLoop；
      // 走内核编排的渠道不再需要 —— 见 dispatchInbound）
      (config as Record<string, unknown>).agentFactory = agentFactory;

      // 会话归属渠道名（sessionChannel 缺省 = handler id）：内核身份解析/恢复/前缀校验都用它
      const sc = handler.sessionChannel ?? handler.id;

      // 设置事件处理：渠道收到消息 → 内核编排（或纯转发钩子）
      handler.onEvent(async (event: ChannelEvent) => {
        if (event.type !== 'message') return;
        const msgEvent = event as ChannelMessageEvent;
        try {
          if (handler.onInboundMessage) {
            // 纯转发渠道（如 TUI → 协议层）：不参与会话管理
            await handler.onInboundMessage(msgEvent);
          } else if (this.sessionService) {
            await this.dispatchInbound(handler, sc, msgEvent);
          } else {
            logger.error('no sessionService wired — cannot dispatch inbound message', undefined, { channel: handler.id });
          }
        } catch (err) {
          logger.error('inbound dispatch error', err instanceof Error ? err : new Error(String(err)), {
            channel: handler.id,
          });
        }
      });

      await handler.start(config);
      state.status = 'active';

      // 会话服务接线：恢复会话 + 注册快照 getter（须在 start 成功后，保证恢复先于首条消息编排）。
      // 纯转发渠道（onInboundMessage，如 TUI）不参与会话管理 → 跳过，
      // 其主 loop 会话 getter 由装配层（runtime-wiring）注册，避免双轨覆盖。
      if (this.sessionService && !handler.onInboundMessage) {
        await this.sessionService.bindChannel(sc);
        this.registerLoopEntry(handler, sc);
      }
      logger.info('channel started', { id: handler.id });
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      logger.error('channel start failed', error instanceof Error ? error : new Error(state.error), {
        id: handler.id,
      });
    }
  }

  // ── 内核编排：①resolve ②loop.run ③reply ────────────────────

  private async dispatchInbound(
    handler: ChannelHandler,
    sc: string,
    event: ChannelMessageEvent,
  ): Promise<void> {
    const svc = this.sessionService!;

    // ① 会话解析（显式 id 归属校验 / 按 identity 策略派生 → 单点持久化映射）
    const sessionId = await svc.resolveSession(sc, event);

    // 会话绑定通知：渠道记录传输态回复目标（sessionMap 等）
    await handler.onSessionBound?.(sessionId, event);

    // ② 获取/创建 loop（LRU）并运行
    const { loop, collectHandler } = await svc.getOrCreateLoop(sc, sessionId);
    const output: ChannelOutputHandler = (await handler.createOutputHandler?.(sessionId, event.metadata)) ?? collectHandler;
    loop.setOutputHandler(output);
    if (event.images?.length) (loop as { channelImages?: unknown }).channelImages = event.images;

    await handler.onLoopStart?.(event, sessionId);
    let runError: unknown;
    try {
      await loop.run(event.content);
    } catch (err) {
      runError = err;
    } finally {
      await handler.onLoopEnd?.(sessionId, runError);
    }

    // ③ 回复（localDefault 渠道本地渲染，跳过 reply 防双写）
    const response = 'getResponse' in output ? (output as { getResponse(): string }).getResponse() : '';
    if (response && !handler.loopCapabilities?.localDefault) {
      await handler.reply(sessionId, { content: response });
    }
    if ('reset' in output) (output as { reset(): void }).reset();
    if (runError) throw runError;
  }

  /**
   * 统一构建 `__channelLoopRegistry` 条目（渠道不再碰 globalThis）。
   * 仅持久消息渠道（persistent 能力）或声明了主动推送能力的渠道参与；
   * localDefault 本地渠道由 runtime-wiring 以主 loop 注册，不在此覆盖。
   */
  private registerLoopEntry(handler: ChannelHandler, sc: string): void {
    const capabilities = handler.loopCapabilities;
    const hasProactive = typeof handler.sendProactiveMessage === 'function';
    if (!capabilities?.persistent && !hasProactive) return;

    const svc = this.sessionService!;
    const g = globalThis as { __channelLoopRegistry?: Map<string, ChannelLoopEntry> };
    if (!g.__channelLoopRegistry) g.__channelLoopRegistry = new Map();
    g.__channelLoopRegistry.set(handler.id, {
      notifyTaskFired: (name: string, sessionId?: string) =>
        svc.runTask({
          channel: sc,
          taskName: name,
          sessionId,
          deliver: (sid, text) => handler.sendProactiveMessage?.(sid, text),
        }),
      sendProactiveMessage: handler.sendProactiveMessage?.bind(handler),
      capabilities: capabilities as ChannelLoopCapabilities,
    });
    logger.info('registered channel loop entry for scheduled task routing', { id: handler.id });
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
      // 解绑会话：已停止的渠道不应再进入下次重启快照（否则快照会携带一个已下线
      // 渠道的陈旧会话，重启后又被它认领）。纯转发渠道本就未绑定，跳过。
      if (this.sessionService && !state.handler.onInboundMessage) {
        this.sessionService.unbindChannel(state.handler.sessionChannel ?? state.handler.id);
      }
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