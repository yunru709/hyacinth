/**
 * plugin-sdk —— 插件开发者契约面（自包含，零内部 import）。
 *
 * 插件开发者只需依赖本文件暴露的契约即可编写插件（JS / TS），
 * 无需了解内核架构实现：运行时能力由宿主经 PluginApi 注入，
 * 服务以字符串 key 访问，manifest 为纯声明式 JSON。
 *
 * 本文件禁止 import 任何内核运行时模块 —— 它是插件面与内核面的
 * 唯一公共边界。内部类型到窄接口的转换集中在 plugins/api.ts，
 * 并以同源守卫保证结构不漂移。
 */

// ============================================================
// Plugin Manifest（plugin.json）
// ============================================================

/**
 * 插件 manifest 格式（plugin.json）
 *
 * 存放于 .agent/plugins/<plugin-id>/plugin.json（用户级）或
 * plugins/<plugin-id>/plugin.json（内置/随代码分发）。
 */
export interface PluginManifest {
  /** 唯一插件 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 简短描述 */
  description: string;
  /** 入口模块路径（相对于 manifest 目录） */
  entry: string;
  /**
   * 依赖的插件 ID（同宿主内其他插件；mount 时校验，缺失直接报错而非运行时 undefined）。
   * 可依赖目录插件与内核插件（统一宿主后），如 ['bypass', 'world-engine']。
   */
  deps?: string[];
  /** 默认是否启用 */
  enabledByDefault?: boolean;
  /** Skill 定义目录列表（相对于 manifest 目录） */
  skills?: string[];
  /** 配置的 JSON Schema */
  configSchema?: Record<string, unknown>;
  /**
   * 架构贡献声明（裁剪式）—— 插件对可替换点的声明式改动。
   * key = 可替换点（'<kind>:<name>'，校验命中 extension-registry 目录）；
   * value = { impl, module? }。未填的点走出厂实现（builtin）。
   */
  architecture?: Record<string, { impl: string; module?: string }>;
  /** 同点冲突优先级（数字，大者生效；缺省 0）。多个插件申报同一点时裁决用。 */
  priority?: number;
  /** 插件版本 */
  version?: string;
}

// ============================================================
// 能力窄接口（契约子集 —— 结构上被内部类型满足，见 plugins/api.ts 同源守卫）
// ============================================================

/** 工具契约 —— 供 api.registerTool()。不含陪伴模式/异步执行等运行时专属字段。 */
export interface HostTool {
  /** 工具名称，全局唯一标识 */
  name: string;
  /** 工具描述，供 LLM 理解工具用途 */
  description: string;
  /** 输入参数的 JSON Schema 定义 */
  inputSchema: Record<string, unknown>;
  /** 执行工具，返回结果文本。signal 可用于中断长时间运行的工具 */
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/** 上下文源加载策略 */
export type HostContextSourceStrategy = 'always_inline' | 'index_only' | 'lazy_expand' | 'phase_bound';
/** 上下文源缓存区 */
export type HostContextSourceCacheability = 'anchor' | 'manifest' | 'summarized' | 'live';

/** 上下文来源契约 —— 供 api.registerContextSource() */
export interface HostContextSource {
  /** 唯一名称 */
  name: string;
  /** 加载策略 */
  strategy: HostContextSourceStrategy;
  /** 缓存区 */
  cacheability: HostContextSourceCacheability;
  /** 简短描述（index_only 策略用于索引显示） */
  description?: string;
  /** 取全量内容（always_inline 与 lazy_expand 用） */
  getContent: () => string | Promise<string>;
}

/** Skill 定义契约 —— 供 api.registerSkill() */
export interface HostSkillDefinition {
  /** 唯一名称 */
  name: string;
  /** 简短描述（用于索引显示） */
  description: string;
  /** 提示词模板（支持 {{variable}} 占位符） */
  promptTemplate: string;
  /** 关联的工具名称列表 */
  relatedTools: string[];
  /** 来源：内置 / 文件加载 / 插件注册 */
  source: 'builtin' | 'file' | 'plugin';
}

/** MCP Server 配置契约 —— 供 api.registerMcpServer() */
export interface HostMcpConfig {
  /** MCP Server 唯一名称 */
  name: string;
  /** stdio 传输：启动子进程的命令 */
  command?: string;
  /** stdio 传输：命令参数 */
  args?: string[];
  /** HTTP SSE 传输：Server URL */
  url?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** SSE 认证请求头 */
  headers?: Record<string, string>;
}

// ── 渠道契约（HostChannel*）──

export type HostChannelStatus = 'registered' | 'starting' | 'active' | 'stopped' | 'error';

/** 渠道收到的事件 */
export type HostChannelEvent =
  | HostChannelMessageEvent
  | HostChannelConnectedEvent
  | HostChannelDisconnectedEvent
  | HostChannelErrorEvent;

/** 用户消息事件 */
export interface HostChannelMessageEvent {
  type: 'message';
  /** 显式会话 ID：协议自带会话的渠道填；缺省 = 内核按 identity 解析 */
  sessionId?: string;
  userId: string;
  content: string;
  channel: string;
  /** 平台身份：内核 identity→sessionId 解析输入 */
  identity?: { userId?: string; chatId?: string; threadId?: string; isGroup?: boolean };
  /** 图片数据（base64 + MIME）。各渠道自行下载后填入，可选 */
  images?: Array<{ data: string; media_type: string }>;
  metadata?: Record<string, unknown>;
}

export interface HostChannelConnectedEvent {
  type: 'connected';
  channel: string;
}

export interface HostChannelDisconnectedEvent {
  type: 'disconnected';
  channel: string;
}

export interface HostChannelErrorEvent {
  type: 'error';
  channel: string;
  error: string;
}

/** Agent 回复给渠道的消息 */
export interface HostChannelReply {
  content: string;
  images?: Array<{ data: string; media_type: string }>;
  metadata?: Record<string, unknown>;
}

/** 跨渠道主动发送的目标接收方 */
export interface HostChannelTarget {
  /** 目标类型：user=私聊用户，chat=群聊 */
  type: 'user' | 'chat';
  /** 目标 ID（格式由各渠道自行定义） */
  id: string;
}

/** 回复函数类型 */
export type HostReplyFn = (reply: HostChannelReply) => Promise<void>;

/** 输出处理器（渠道消息收集用） */
export interface HostChannelOutputHandler {
  onText?(content: string): void;
  onToolUse?(name: string, inputSummary: string): void;
  onStatus?(message: string, level?: string): void;
  onTurnStart?(): void;
  onFlush?(): void;
  onInterrupt?(): void;
}

/** AgentLoop 运行接口（渠道通过工厂创建） */
export interface HostChannelSessionRunner {
  run(input: string): Promise<void>;
  setOutputHandler(handler: HostChannelOutputHandler): void;
}

/** AgentLoop 创建工厂（由宿主注入，渠道通过此接口创建 AgentLoop） */
export interface HostAgentFactory {
  createAgent(options: {
    sessionId?: string;
    outputHandler: HostChannelOutputHandler;
    channelsInfo?: unknown;
    /** 渠道标识 */
    channel?: string;
  }): Promise<{ loop: HostChannelSessionRunner }>;
}

/** 渠道配置 */
export interface HostChannelConfig {
  [key: string]: unknown;
  /** 是否启用此渠道 */
  enabled?: boolean;
}

/**
 * 渠道处理器契约 —— 供 api.registerChannel()。
 * 一个 Channel 是 agent 与外部世界之间的消息管道（TUI / HTTP / 企微 / 飞书…）。
 */
export interface HostChannelHandler {
  /** 唯一渠道 ID */
  readonly id: string;
  /** 显示名称 */
  readonly name: string;
  /** 简短描述 */
  readonly description: string;
  /** 是否由插件注册（vs 内置渠道） */
  readonly pluginId?: string;

  /** 启动渠道（建连、监听、注册路由） */
  start(config: HostChannelConfig): Promise<void>;
  /** 停止渠道（断连、清理资源） */
  stop(): Promise<void>;
  /** 订阅事件（渠道收到消息时调用 handler(event)） */
  onEvent(handler: (event: HostChannelEvent) => Promise<void>): void;
  /** 发送回复（Gateway 调此方法把 Agent 回复发回给用户） */
  reply(sessionId: string, reply: HostChannelReply): Promise<void>;
  /** 纯转发钩子（可选）：仅「把消息原样转发给协议层/上层」的渠道实现；缺省 = 内核编排 */
  onInboundMessage?(event: HostChannelMessageEvent): Promise<void>;
  /** 自定义输出处理器（可选）：逐 token 渲染的渠道实现；可为异步；缺省 = 内核 collectHandler + reply() 一次性发送 */
  createOutputHandler?(sessionId: string, metadata?: Record<string, unknown>): HostChannelOutputHandler | Promise<HostChannelOutputHandler | undefined> | undefined;
  /** 会话绑定通知（可选）：内核解析出 sessionId 后回调，渠道据此记录传输态回复目标 */
  onSessionBound?(sessionId: string, event: HostChannelMessageEvent): Promise<void> | void;
  /** loop 生命周期通知（可选）：内核编排在 loop.run 开始前回调（如「正在输入」） */
  onLoopStart?(event: HostChannelMessageEvent, sessionId: string): Promise<void> | void;
  /** loop 生命周期通知（可选）：内核编排在 loop.run 结束后回调；error 非空 = 运行异常 */
  onLoopEnd?(sessionId: string, error?: unknown): Promise<void> | void;
  /** 本渠道 loop 能力声明（定时任务路由/陪伴推送用）；缺省 = 无能力 */
  readonly loopCapabilities?: { persistent?: boolean; localDefault?: boolean; fallbackPriority?: number };
  /** 配置热更新（可选） */
  updateConfig?(newConfig: Record<string, unknown>): Promise<void>;
  /** 处理 TUI 子命令（可选），如 /<channelId>/<subCmd> */
  handleTuiCommand?(cmdPath: string, args: string): Promise<string | null>;
  /** 获取渠道状态 */
  getStatus(): HostChannelStatus;
  /** 主动发送消息（传输能力，可选）：定时任务结果推送等主动消息的出口 */
  sendProactiveMessage?(sessionId: string, text: string): Promise<void>;
  /** 主动发送消息（跨渠道借用能力入口，可选） */
  send?(target: HostChannelTarget, content: HostChannelReply): Promise<string>;
}

// ============================================================
// 服务目录（getService 的字符串 key）
// ============================================================

/**
 * 内核能力服务 key 清单。
 * 插件经 api.getService(key) 取用；运行时仍按字符串访问，本目录仅供
 * 文档化与类型补全。与内核能力服务注册处保持同源（改动需同步）。
 */
export const SERVICE_CATALOG = [
  /** 旁路管理器访问器（注册/激活/停用旁路 agent） */
  'bypass.manager',
  /** 世界引擎工厂（创建 WorldEngine 实例） */
  'world-engine.createAgent',
  /** 当前世界引擎实例（插件注册，路由/UI 层取用） */
  'world-engine.agent',
  /** 上下文模式切换窄接口（companion Router + 角色回填） */
  'context.mode',
] as const;

export type ServiceKey = (typeof SERVICE_CATALOG)[number];

// ============================================================
// Plugin Definition（由 definePlugin() 返回）
// ============================================================

export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  configSchema?: Record<string, unknown>;
  register: (api: PluginApi) => void | Promise<void>;
  onActivate?: (api: PluginApi) => void | Promise<void>;
  onDeactivate?: (api: PluginApi) => void | Promise<void>;
}

// ============================================================
// Plugin API（暴露给插件的能力 —— 全部方法参数/返回用窄接口）
// ============================================================

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface PluginApi {
  /** 注册一个工具 */
  registerTool(tool: HostTool): void;
  /** 注册一个 Skill */
  registerSkill(skill: HostSkillDefinition): void;
  /** 注册一个 ContextSource */
  registerContextSource(source: HostContextSource): void;
  /** 注册一个 MCP Server 配置（宿主负责连接和桥接） */
  registerMcpServer(config: HostMcpConfig): void;
  /** 注册一个渠道处理器（将插件扩展为 IM / Webhook / 自定义消息源） */
  registerChannel(handler: HostChannelHandler, config?: HostChannelConfig): void;
  /**
   * 注册一个内核服务（经宿主注册，卸载时自动恢复注册前的值 —— 支持热替换回滚）。
   */
  registerService(key: string, service: unknown): void;

  /**
   * 读取其他插件/内核注册的服务（如取 bypass.manager / world-engine.createAgent）。
   * 目录插件编排内核能力的通道。
   */
  getService<T = unknown>(key: string): T | undefined;

  /** 取消注册一个工具 */
  unregisterTool(name: string): void;
  /** 取消注册一个 Skill */
  unregisterSkill(name: string): void;
  /** 取消注册一个 MCP Server */
  unregisterMcpServer(name: string): void;
  /** 取消注册一个 ContextSource */
  unregisterContextSource(name: string): void;
  /** 取消注册一个渠道处理器 */
  unregisterChannel(id: string): void;

  /**
   * 挂载主循环钩子（观察/过滤）。卸载插件时随生命周期账本自动摘除。
   */
  onHook?(name: string, handler: (payload: unknown) => void | Promise<void>): void;
  /**
   * 包裹主循环接缝（可短路/改写，如拦截 beforeToolExecute 做权限过滤）。
   * 卸载插件时自动摘除。
   */
  aroundHook?(name: string, handler: (payload: unknown, next: (p: unknown) => Promise<unknown>) => Promise<unknown>): void;

  /** 获取插件自身的配置 */
  getConfig<T = Record<string, unknown>>(): T;
  /** 日志记录器 */
  logger: PluginLogger;
  /** 插件 ID */
  pluginId: string;
}
