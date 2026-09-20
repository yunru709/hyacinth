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
  /**
   * 显式会话 ID：协议自带会话的渠道填（TUI/WebUI/HTTP）。
   * 缺省 = 内核按 identity 解析（会话主控权归 SessionService，渠道不再自行决定 sessionId）。
   */
  sessionId?: string;
  userId: string;
  content: string;
  channel: string;
  /** 平台身份：内核 identity→sessionId 解析输入（渠道只解析协议、提供身份，不决定 sessionId） */
  identity?: { userId?: string; chatId?: string; threadId?: string; isGroup?: boolean };
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

// ================================================================
// ChannelTarget — 跨渠道发送目标
// ================================================================
//
// 用于 ChannelHandler.send() 的第一个参数，指定消息接收方。
// 当前仅区分私聊和群聊两种目标类型，不做更细粒度的抽象——
// 各渠道的 ID 体系差异太大（飞书 ou_/oc_、微信 wxid、TUI sessionId），
// 统一抽象反而增加理解成本。由各渠道的 send() 实现自行解析目标 ID。
//
// 新增渠道时：如果该渠道有其他目标类型（如 Telegram 的 channel/supergroup），
// 扩展此 type 联合即可。
// ================================================================

/** 跨渠道主动发送的目标接收方 */
export interface ChannelTarget {
  /** 目标类型：user=私聊用户，chat=群聊 */
  type: 'user' | 'chat';
  /** 目标 ID（格式由各渠道自行定义：飞书 ou_/oc_，微信 wxid 等） */
  id: string;
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
    /** 渠道标识 */
    channel?: string;
    /**
     * 懒登记会话：调用方已铸好 sessionId，但**只登记不落盘**（不建目录不写文件），
     * 目录与 meta/events/stats 推迟到**首条用户消息**由 loop.materializeSessionIfNeeded() 物化。
     * WebUI/桌面端每次 WS 连接都带一个全新 id ⇒ 不开此标志就会"每刷新一次留一个空壳会话" ✗
     */
    lazySession?: boolean;
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
/**
 * 渠道能力声明（定时任务路由 / 陪伴推送用）。
 *
 * 目的：让**核心按能力路由，而不是按渠道名**。历史上核心把渠道名写死在业务逻辑里
 * —— 定时任务兜底链写死 `'feishu'`、本地主 loop 写死 `'tui'`、陪伴广播固定挑飞书
 * —— 新增渠道无法参与这套决策。现在由渠道在注册自己的 loop 条目时声明能力，
 * 核心只认能力。
 */
export interface ChannelLoopCapabilities {
  /** 持久消息渠道：用户离线也能收到 → 定时任务最后兜底 + 陪伴推送目标 */
  persistent?: boolean;
  /** 本地默认渠道（本地 loop / TUI）：不作主动推送目标 */
  localDefault?: boolean;
  /** 兜底优先级（大者优先，缺省 0）；多个持久渠道同时在线时据此裁决 */
  fallbackPriority?: number;
}

/** `__channelLoopRegistry` 条目：渠道自己注册的 loop 能力面（定时任务路由消费） */
export interface ChannelLoopEntry {
  notifyTaskFired(name: string, sessionId?: string): Promise<void>;
  /** 主动推送（持久渠道才有）；缺省表示不支持主动推送 */
  sendProactiveMessage?(sessionId: string, text: string): Promise<void>;
  /** 能力声明，见 `ChannelLoopCapabilities` */
  capabilities?: ChannelLoopCapabilities;
}

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
   * 本渠道 sessionId 前缀（单前缀如 'hub_，或多前缀如 ['webui_', 'ui_']）。
   *
   * 注册渠道时由 ChannelManager.register 自动登记到 session-channel 前缀表，
   * 使该渠道的 sessionId 能被正确推断渠道；unregister 时同步注销。
   * 缺省不注册（该渠道不通过 sessionId 前缀推断）。
   *
   * 内置渠道请引用 src/session-channel.ts 里内置前缀表的常量（单一真源），
   * 不要写重复字面量 —— 曾经手写字面量导致 clawbot_ 漏注册、会话归属推断失效。
   * 插件渠道直接声明自己的前缀；插件被禁用时由 auto-detect 的发现阶段兜底注册。
   */
  readonly sessionPrefix?: string | readonly string[];

  /**
   * 写入会话归属（`meta.json` 的 `channel` 字段）时使用的渠道名。
   *
   * 缺省 = handler id。仅当「渠道 id」与「会话归属渠道名」不一致时才需显式声明
   * —— 典型：`HttpWebhookChannel.id = 'http-webhook'`，但它承载的是 WebUI，
   * 会话记录/前端展示统一用 `'webui'`。
   *
   * 该值同时决定前缀解析结果（`sessionPrefix` → 本字段），因此**必须**与
   * 创建 Agent 时传的 `channel` 选项一致，否则「按渠道恢复最近会话」会匹配不上。
   */
  readonly sessionChannel?: string;

  /**
   * 本渠道 loop 能力声明（定时任务路由 / 陪伴推送用）。
   *
   * 由 ChannelManager 在 startChannel 统一生成 `__channelLoopRegistry` 条目
   * （渠道**不再碰 globalThis**）；缺省 = 无能力（不参与主动路由/兜底）。
   */
  readonly loopCapabilities?: ChannelLoopCapabilities;

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
   * 纯转发钩子（可选）：仅「把消息原样转发给协议层/上层」的渠道实现（如 TUI）。
   * 缺省 = 内核编排（SessionService 解析会话 → loop.run → reply）。
   * 实现此钩子的渠道**不参与**会话管理，自身对 loop/回复完全无感。
   */
  onInboundMessage?(event: ChannelMessageEvent): Promise<void>;

  /**
   * 自定义输出处理器（可选）：逐 token 渲染的渠道实现（如飞书流式卡片）。
   * 可为异步（流式卡片的建卡/首帧需要 await）；缺省/返回 undefined = 内核 collectHandler + reply() 一次性发送。
   */
  createOutputHandler?(sessionId: string, metadata?: Record<string, unknown>): ChannelOutputHandler | Promise<ChannelOutputHandler | undefined> | undefined;

  /**
   * 会话绑定通知（可选）：内核解析出本消息的 sessionId 后回调，
   * 渠道据此记录传输态回复目标（sessionMap 等）。**不决定** sessionId，只记录。
   */
  onSessionBound?(sessionId: string, event: ChannelMessageEvent): Promise<void> | void;

  /**
   * loop 生命周期通知（可选）：内核编排在 loop.run **开始前**回调。
   * 供需要「生成期传输行为」的渠道使用（如微信「正在输入」）。
   */
  onLoopStart?(event: ChannelMessageEvent, sessionId: string): Promise<void> | void;
  /** loop 生命周期通知（可选）：内核编排在 loop.run **结束后**回调；error 非空 = 运行异常。 */
  onLoopEnd?(sessionId: string, error?: unknown): Promise<void> | void;

  /**
   * 配置热更新（可选）
   * Gateway 配置监听检测到变更时调用
   */
  updateConfig?(newConfig: Record<string, unknown>): Promise<void>;

  /**
   * 处理 TUI 子命令（可选）。
   * 当用户在 TUI 中输入 /<channelId>/<subCmd> 时，框架将 cmdPath
   * 路由到此方法。渠道根据 cmdPath 自行分发。
   *
   * @param cmdPath 完整命令路径，如 "clawbot/login"
   * @param args 命令后的剩余参数
   * @returns 要渲染到 TUI 的文本，或 null 表示不处理此命令
   */
  handleTuiCommand?(cmdPath: string, args: string): Promise<string | null>;

  /**
   * 获取渠道状态
   */
  getStatus(): ChannelStatus;

  /**
   * 主动发送消息（传输能力，可选）：定时任务结果推送等主动消息的出口。
   * 由 ChannelManager 生成 `__channelLoopRegistry` 条目时统一绑定；缺省 = 不支持主动推送。
   */
  sendProactiveMessage?(sessionId: string, text: string): Promise<void>;

  /**
   * 主动发送消息（跨渠道借用能力入口，可选）。
   *
   * 设计意图：reply() 是"回复"——在内核编排生命周期内，将 Agent
   * 的响应发回给当前会话的用户。send() 是"借用"——任何渠道的 Agent
   * 都可以调用其他渠道的 send() 来借用其发送能力，不依赖内核编排生命周期。
   *
   * 行为保证（"纯借用"语义）：
   *   - 不创建 session —— 消息是一次性的，不关联 AgentLoop
   *   - 不写 conversation —— 不污染对话历史
   *   - 不影响渠道内部状态 —— sessionMap、消息队列等完全不变
   *
   * 调用来源：MessageDispatcher → send_channel_message 工具 → Agent
   *
   * 未实现 = 该渠道不支持被外部借用（返回 undefined，MessageDispatcher 会给出友好提示）。
   *
   * @param target  目标接收方（用户或群聊），各渠道自行解析 ID 格式
   * @param content 消息内容（文本 + 可选图片），复用 ChannelReply 避免定义新类型
   * @returns 发送结果描述（成功或失败原因），不抛异常
   */
  send?(target: ChannelTarget, content: ChannelReply): Promise<string>;
}

// ── 渠道状态 ─────────────────────────────────────────────────

export type ChannelStatus = 'registered' | 'starting' | 'active' | 'stopped' | 'error';

export interface ChannelState {
  handler: ChannelHandler;
  status: ChannelStatus;
  error?: string;
  config: ChannelConfig;
}