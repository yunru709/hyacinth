import type {
  ChannelHandler,
  ChannelEvent,
  ChannelReply,
  ChannelConfig,
  ChannelStatus,
  ChannelMessageEvent,
} from '../interface.js';
/**
 * TUI 渠道 sessionId 前缀（**渠道自管**：定义在本渠道模块内，核心注册表零渠道知识）。
 * 该渠道被 register 到 ChannelManager 时由框架自动登记，无需任何核心侧改动。
 */
export const TUI_SESSION_PREFIX = 'tui_';

/**
 * TUI Channel — 将终端界面包装为标准渠道
 * 
 * 这是一个轻量包装，不包含 blessed 渲染逻辑。
 * blessed UI 代码仍留在 tui.ts 中，只是输入/输出通过此渠道桥接。
 */
export class TuiChannel implements ChannelHandler {
  readonly id = 'tui';
  readonly name = 'TUI Terminal';
  readonly description = '内建终端用户界面，通过 blessed 渲染';
  readonly pluginId = undefined;
  /** sessionId 前缀（引用 src/session-channel.ts 内置前缀表的常量，勿写字面量） */
  readonly sessionPrefix = TUI_SESSION_PREFIX;
  /** 本地默认渠道：本地主 loop 已由 runtime-wiring 注册；能力声明供路由/推送判定（不作主动推送目标） */
  readonly loopCapabilities = { localDefault: true } as const;

  private status: ChannelStatus = 'registered';
  private eventHandler: ((event: ChannelEvent) => Promise<void>) | null = null;

  async start(config: ChannelConfig): Promise<void> {
    this.status = 'active';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  onEvent(handler: (event: ChannelEvent) => Promise<void>): void {
    this.eventHandler = handler;
  }

  /**
   * 发送用户输入消息（由 tui.ts 的 input handler 调用）
   */
  async sendMessage(sessionId: string, content: string): Promise<void> {
    if (!this.eventHandler) return;
    await this.eventHandler({
      type: 'message',
      sessionId,
      userId: 'tui-user',
      content,
      channel: this.id,
      metadata: { source: 'tui' },
    });
  }

  /**
   * 发送 Agent 回复到 TUI（由 ChannelManager 的 MessageProcessor 调用）
   */
  async reply(_sessionId: string, reply: ChannelReply): Promise<void> {
    // 输出到终端（由 tui.ts 注册的回调处理）
    if (this.onReply) {
      this.onReply(reply.content);
    }
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  // ── TUI 专属回调（由 tui.ts 设置） ──

  /** Agent 回复回调（tui.ts 设置此函数来输出到屏幕） */
  onReply: ((content: string) => void) | null = null;

  /** 消息处理回调（由 tui.ts 设置，TUI 使用主 loop 处理消息） */
  onHandleMessage: ((event: ChannelMessageEvent) => Promise<void>) | null = null;

  /**
   * 纯转发钩子：TUI 不参与会话管理 —— 消息原样转发给协议层（tui.ts 设置 onHandleMessage）。
   * 由 ChannelManager 在渠道收到消息时调用（onInboundMessage 存在即不走进内核编排）。
   */
  async onInboundMessage(event: ChannelMessageEvent): Promise<void> {
    if (this.onHandleMessage) {
      await this.onHandleMessage(event);
    }
  }
}