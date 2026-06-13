// ============================================================
// Channel — 渠道抽象层
// ============================================================
//
// 一个 Channel 是 agent 与外部世界之间的消息管道。
// 用户可以来自 TUI、HTTP webhook、企业微信、飞书、钉钉……
// 框架不关心消息来源，只关心收发接口。
//
// 渠道可以是：
//   - 内置渠道（TUI、HTTP webhook）— 框架自带
//   - 插件渠道（企微、飞书、微信、Telegram…）— 通过 PluginApi.registerChannel() 注册
//   - MCP 渠道 — 通过 MCP Server 暴露
// ============================================================

// ── 渠道配置 ─────────────────────────────────────────────────

export interface ChannelConfig {
  /** 用户自定义配置项 */
  [key: string]: unknown;
  /** 是否启用此渠道 */
  enabled?: boolean;
}

// ── 消息类型 ─────────────────────────────────────────────────

/** 渠道收到的事件 */
export type ChannelEvent =
  | ChannelMessageEvent
  | ChannelConnectedEvent
  | ChannelDisconnectedEvent
  | ChannelErrorEvent;

/** 用户消息事件 */
export interface ChannelMessageEvent {
  type: 'message';
  sessionId: string;
  userId: string;
  content: string;
  channel: string;
  /** 图片数据（base64 + MIME）。各渠道自行下载后填入，可选 */
  images?: Array<{ data: string; media_type: string }>;
  metadata?: Record<string, unknown>;
}

/** 渠道连接成功 */
export interface ChannelConnectedEvent {
  type: 'connected';
  channel: string;
}

/** 渠道断开连接 */
export interface ChannelDisconnectedEvent {
  type: 'disconnected';
  channel: string;
}

/** 渠道错误 */
export interface ChannelErrorEvent {
  type: 'error';
  channel: string;
  error: string;
}

// ── 回复类型 ─────────────────────────────────────────────────

/** Agent 回复给渠道的消息 */
export interface ChannelReply {
  content: string;
  images?: Array<{ data: string; media_type: string }>;
  metadata?: Record<string, unknown>;
}

// ── Agent 工厂与运行接口 ─────────────────────────────────────

/** 输出处理器（渠道消息收集用） */
export interface ChannelOutputHandler {
  onText?(content: string): void;
  onToolUse?(name: string, inputSummary: string): void;
  onStatus?(message: string, level?: string): void;
  onTurnStart?(): void;
  onFlush?(): void;
  onInterrupt?(): void;
}

/** AgentLoop 运行接口 */
export interface ChannelSessionRunner {
  run(input: string): Promise<void>;
  setOutputHandler(handler: ChannelOutputHandler): void;
}

/** AgentLoop 创建工厂（由 gateway 注入，渠道通过此接口创建 AgentLoop） */
export interface AgentFactory {
  createAgent(options: {
    sessionId?: string;
    outputHandler: ChannelOutputHandler;
    channelsInfo?: unknown;
  }): Promise<{ loop: ChannelSessionRunner }>;
}

/** 回复函数类型 */
export type ReplyFn = (reply: ChannelReply) => Promise<void>;

// ── 渠道处理器接口 ───────────────────────────────────────────

/**
 * ChannelHandler — 所有渠道必须实现此接口。
 *
 * 生命周期：
 *   1. register → 注册到 ChannelManager
 *   2. start() → 启动渠道（建连、监听）
 *   3. onEvent() → 渠道收到消息时调用注册的回调
 *   4. reply() → Gateway 调此方法向用户发送回复
 *   5. stop() → 停止渠道
 */
export interface ChannelHandler {
  /** 唯一渠道 ID */
  readonly id: string;
  /** 显示名称 */
  readonly name: string;
  /** 简短描述 */
  readonly description: string;
  /** 是否由插件注册（vs 内置渠道） */
  readonly pluginId?: string;

  /**
   * 启动渠道
   * 渠道在此方法中建立连接、启动监听、注册路由等
   */
  start(config: ChannelConfig): Promise<void>;

  /**
   * 停止渠道
   * 渠道在此方法中断开连接、清理资源
   */
  stop(): Promise<void>;

  /**
   * 订阅事件
   * Gateway 调用此方法，传入事件处理函数。
   * 渠道在收到消息时调用 handler(event)。
   */
  onEvent(handler: (event: ChannelEvent) => Promise<void>): void;

  /**
   * 发送回复
   * Gateway 调用此方法，将 Agent 的回复发回给用户。
   */
  reply(sessionId: string, reply: ChannelReply): Promise<void>;

  /**
   * 处理消息（渠道自行管理 session、AgentLoop、回复）
   * Gateway 不再在统一回调中分支处理不同渠道
   */
  handleMessage(
    event: ChannelMessageEvent,
    replyFn: ReplyFn,
    agentFactory: AgentFactory,
  ): Promise<void>;

  /**
   * 配置热更新（可选）
   * Gateway 配置监听检测到变更时调用
   */
  updateConfig?(newConfig: Record<string, unknown>): Promise<void>;

  /**
   * 获取渠道状态
   */
  getStatus(): ChannelStatus;
}

// ── 渠道状态 ─────────────────────────────────────────────────

export type ChannelStatus = 'registered' | 'starting' | 'active' | 'stopped' | 'error';

export interface ChannelState {
  handler: ChannelHandler;
  status: ChannelStatus;
  error?: string;
  config: ChannelConfig;
}