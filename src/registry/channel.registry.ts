import { GenericRegistry, type RegistryItem } from './base.js';
import { ChannelManager } from '../channels/manager.js';
import type { ChannelHandler, ChannelConfig, ChannelReply, AgentFactory } from '../channels/interface.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisteredChannel extends RegistryItem {
  name: string;
  handler: ChannelHandler;
  config: ChannelConfig;
  source?: string;
}

// ---------------------------------------------------------------------------
// ChannelRegistry
// ---------------------------------------------------------------------------

/**
 * ChannelRegistry — 带 enable/disable 能力的渠道注册表。
 *
 * 包装 ChannelManager，在其基础上添加启用/禁用控制：
 * - 禁用的渠道不会被启动（startAll 时自动过滤）
 * - 查询接口（getAll / get）仅返回已启用的渠道
 */
export class ChannelRegistry extends GenericRegistry<RegisteredChannel> {
  private manager: ChannelManager;

  constructor(manager?: ChannelManager) {
    super();
    this.manager = manager ?? new ChannelManager();
  }

  // ── 注册 / 注销 ──────────────────────────────────────────────

  register(item: RegisteredChannel): void {
    super.register(item);
    this.manager.register(item.handler, item.config);
  }

  unregister(name: string): boolean {
    // ChannelManager 没有 unregister 方法，仅从 Registry 中移除
    return super.unregister(name);
  }

  // ── 查询（仅已启用） ──────────────────────────────────────────

  /** 获取指定渠道（禁用的返回 undefined） */
  get(name: string): RegisteredChannel | undefined {
    return super.get(name);
  }

  /** 获取所有已启用的渠道 */
  getAll(): RegisteredChannel[] {
    return super.getAll();
  }

  // ── 启用 / 禁用 ──────────────────────────────────────────────

  disable(name: string): void {
    super.disable(name);
  }

  enable(name: string): void {
    super.enable(name);
  }

  // ── 生命周期代理 ─────────────────────────────────────────────

  /**
   * 启动所有已启用的渠道。
   *
   * 如果提供了 enabledIds，仅启动其中已启用的渠道。
   * 否则，启动所有本注册表中未禁用的渠道。
   */
  async startAll(
    agentFactory: AgentFactory,
    enabledIds?: string[],
  ): Promise<void> {
    // 如果指定了 enabledIds，过滤出已启用的
    if (enabledIds) {
      const filtered = enabledIds.filter((id) => this.isEnabled(id));
      return this.manager.startAll(agentFactory, filtered);
    }
    return this.manager.startAll(agentFactory);
  }

  /** 停止所有渠道 */
  async stopAll(): Promise<void> {
    return this.manager.stopAll();
  }

  /** 重启指定渠道 */
  async restart(id: string, agentFactory: AgentFactory): Promise<void> {
    return this.manager.restart(id, agentFactory);
  }

  // ── 发送代理 ─────────────────────────────────────────────────

  /** 通过指定渠道发送回复 */
  async send(
    channelId: string,
    sessionId: string,
    reply: ChannelReply,
  ): Promise<void> {
    return this.manager.send(channelId, sessionId, reply);
  }

  // ── 状态查询 ─────────────────────────────────────────────────

  /** 获取所有渠道状态摘要 */
  getStatusSummary() {
    return this.manager.getStatusSummary();
  }

  /** 是否已启动 */
  isStarted(): boolean {
    return this.manager.isStarted();
  }

  // ── 内部工具 ─────────────────────────────────────────────────

  /** 获取内部 ChannelManager */
  getManager(): ChannelManager {
    return this.manager;
  }
}