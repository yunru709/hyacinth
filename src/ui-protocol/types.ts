// ============================================================
// UI 协议层 — 核心类型
// ============================================================
// 统一 UI 协议：为任意形态的 UI（TUI / WebUI / 未来渠道）提供
// 覆盖全部操作面的双向协议。本文件只定义协议类型与常量，
// 不依赖任何后端内部模块，保证协议层独立、可移植。
//
// 消息格式：
//   request  { id, method, params }      UI → 后端
//   response { id, ok, result|error }    后端 → UI
//   event    { type, payload }           后端 → UI（推送）
//
// method 命名空间：<domain>.<action>，domain 见 UI_DOMAIN。
// event 命名空间同为 <domain>.<action>，另有 'ui.' 保留前缀承载
// 连接生命周期事件（无对应域，属传输层）。
// ============================================================

// ────────────────────────────────────────────────────────────
// 传输无关的统一消息
// ────────────────────────────────────────────────────────────

/** 请求唯一 ID 类型（由 UI 客户端生成，用于关联响应） */
export type RequestId = string;

/** 错误信息 */
export interface UiError {
  code: string;
  message: string;
  /** 可选：错误详情（如 stack、path 等） */
  details?: unknown;
}

/** UI → 后端：RPC 请求 */
export interface UiRequest {
  kind: 'request';
  id: RequestId;
  /** 如 'config.get'、'session.list'、'model.switch' */
  method: string;
  params?: unknown;
}

/** 后端 → UI：RPC 响应 */
export interface UiResponse {
  kind: 'response';
  id: RequestId;
  ok: boolean;
  /** ok=true 时返回结果 */
  result?: unknown;
  /** ok=false 时返回错误 */
  error?: UiError;
}

/** 后端 → UI：事件推送 */
export interface UiEvent {
  kind: 'event';
  type: string;
  payload?: unknown;
}

/** 统一消息（三种形态的并集） */
export type UiMessage = UiRequest | UiResponse | UiEvent;

// ────────────────────────────────────────────────────────────
// 协议版本与能力协商（protocol.meta）
// ────────────────────────────────────────────────────────────

/**
 * UI 协议版本号（语义化）。客户端应读取 protocol.meta.version 并做
 * 兼容性判断；主版本变更 = 破坏性协议变更。
 */
export const UI_PROTOCOL_VERSION = '1.0.0';

/** protocol.meta.get 返回的完整能力描述（P5-3） */
export interface ProtocolMeta {
  /** 协议版本号（语义化） */
  version: string;
  /** 已注册域列表（如 ['message', 'state', ...]） */
  domains: string[];
  /** 每域可用方法（如 { message: ['chat', 'stop'], state: ['get'] }） */
  methods: Record<string, string[]>;
  /**
   * 方法参数 schema（可扩展：后续各域可声明参数形状）。
   * 当前协议层尚未声明逐方法 schema，此字段保留为扩展点。
   */
  schemas?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────
// 领域命名空间常量（method 前缀）
// ────────────────────────────────────────────────────────────

export const UI_DOMAIN = {
  /** 消息流：chat / stop / askUserResolve / history */
  MESSAGE: 'message',
  /** 状态快照：model / provider / 模式 / token / 缓存 / plan */
  STATE: 'state',
  /** 会话管理：list / resume / create / delete / export / batchDelete / getLatest */
  SESSION: 'session',
  /** 配置读写：get / getAll / set / merge / reset / schema */
  CONFIG: 'config',
  /** 模型通道管理：providers / channels / switch / thinking / local* */
  MODEL: 'model',
  /** 命令系统：list / execute */
  COMMAND: 'command',
  /** 权限应答：resolve */
  PERMISSION: 'permission',
  /** 知识库：开关 / zone4（对应 TUI /zone4） */
  KB: 'kb',
  /** 后台进程（对应 TUI /bg）：list / kill */
  PROCESS: 'process',
  /** 旁路 agent 编排（对应 TUI /orchestrator）：get / setEnabled */
  ORCHESTRATOR: 'orchestrator',
  /** 上下文分区预览：previewZone */
  CONTEXT: 'context',
  /** 工具注册表：list / toggle / bundles */
  TOOL: 'tool',
  /** 工具包：create / delete / activate / deactivate / addTools / removeTools / list */
  BUNDLE: 'bundle',
  /** MCP 服务器：list / add / remove / enable / disable / reconnect */
  MCP: 'mcp',
  /** 插件状态（B-4：挂载失败可见性，对应内核 PluginHost.list()）：list */
  PLUGIN: 'plugin',
  /** Supervisor 监督状态（S5 可观测面）：status */
  SUPERVISOR: 'supervisor',
  /** 架构监督（扩展注册表方案）：目录/名单/生效视图 list / get / toggle */
  ARCH: 'arch',
  /** 陪伴模式：角色激活 / 音色库 / 生成语音 / 台词历史 */
  COMPANION: 'companion',
  /** 调度任务（对应 TUI /schedule）：list / add / addDaily / remove / toggle / runtime */
  SCHEDULE: 'schedule',
  /** 协议元信息（P5-3）：版本/能力协商 get */
  META: 'meta',
} as const;

/**
 * 方法命名空间（<domain>.<action>）。
 *
 * P5-4 同源契约：本表必须与各域工厂实际返回的 handler 键**双向一致**——
 * 表里每一条都必须真实可调用，域实现的每一个方法都必须在表内声明。
 * 由 `index.test.ts` 的「常量同源守卫」用真实装配（UiProtocolSession 全 18 域）
 * 双向断言，任一侧新增/遗漏都会让测试变红。
 *
 * 注意：中断入口是 `message.stop`（不是 message.interrupt）；
 * `message.interrupt` 是**事件**（见 UI_EVENT），不是方法。
 */
export const UI_METHOD = {
  // message
  MESSAGE_CHAT: 'message.chat',
  MESSAGE_STOP: 'message.stop',
  MESSAGE_HISTORY: 'message.history',
  MESSAGE_ASK_USER_RESOLVE: 'message.askUserResolve',
  // state
  STATE_GET: 'state.get',
  STATE_STATS: 'state.stats',
  STATE_SUBSCRIBE: 'state.subscribe',
  STATE_UNSUBSCRIBE: 'state.unsubscribe',
  // session
  SESSION_LIST: 'session.list',
  SESSION_RESUME: 'session.resume',
  SESSION_CREATE: 'session.create',
  SESSION_DELETE: 'session.delete',
  SESSION_SWITCH: 'session.switch',
  SESSION_EXPORT: 'session.export',
  SESSION_BATCH_DELETE: 'session.batchDelete',
  SESSION_GET_LATEST: 'session.getLatest',
  // config
  CONFIG_GET: 'config.get',
  CONFIG_GET_ALL: 'config.getAll',
  CONFIG_SET: 'config.set',
  CONFIG_MERGE: 'config.merge',
  CONFIG_RESET: 'config.reset',
  CONFIG_SCHEMA: 'config.schema',
  // model
  MODEL_LIST_PROVIDERS: 'model.listProviders',
  MODEL_SWITCH: 'model.switch',
  MODEL_TOGGLE: 'model.toggle',
  MODEL_SET_THINKING: 'model.setThinking',
  MODEL_LIST_CHANNELS: 'model.listChannels',
  MODEL_UPSERT_CHANNEL: 'model.upsertChannel',
  MODEL_REMOVE_CHANNEL: 'model.removeChannel',
  MODEL_SET_CHANNEL_MODEL: 'model.setChannelModel',
  MODEL_RESET_CHANNEL_MODEL: 'model.resetChannelModel',
  MODEL_SET_CHANNEL_ROLE: 'model.setChannelRole',
  MODEL_LIST_ROLES: 'model.listRoles',
  MODEL_GET_CHANNEL_INFO: 'model.getChannelInfo',
  MODEL_SOURCES: 'model.sources',
  MODEL_GET_ACTIVE: 'model.getActive',
  MODEL_LIST_LOCAL_MODELS: 'model.listLocalModels',
  MODEL_SET_LOCAL_CONFIG: 'model.setLocalConfig',
  MODEL_LOCAL_START: 'model.localStart',
  MODEL_LOCAL_STOP: 'model.localStop',
  MODEL_LOCAL_SWITCH: 'model.localSwitch',
  MODEL_LOCAL_REGISTER: 'model.localRegister',
  MODEL_LOCAL_UNREGISTER: 'model.localUnregister',
  MODEL_LOCAL_SCAN: 'model.localScan',
  // command
  COMMAND_LIST: 'command.list',
  COMMAND_EXECUTE: 'command.execute',
  // permission
  PERMISSION_RESOLVE: 'permission.resolve',
  // schedule
  SCHEDULE_LIST: 'schedule.list',
  SCHEDULE_ADD: 'schedule.add',
  SCHEDULE_ADD_DAILY: 'schedule.addDaily',
  SCHEDULE_REMOVE: 'schedule.remove',
  SCHEDULE_TOGGLE: 'schedule.toggle',
  SCHEDULE_RUNTIME: 'schedule.runtime',
  // kb
  KB_GET: 'kb.get',
  KB_SET_ENABLED: 'kb.setEnabled',
  KB_SET_ZONE4: 'kb.setZone4',
  // process
  PROCESS_LIST: 'process.list',
  PROCESS_KILL: 'process.kill',
  // orchestrator
  ORCHESTRATOR_GET: 'orchestrator.get',
  ORCHESTRATOR_SET_ENABLED: 'orchestrator.setEnabled',
  // context
  CONTEXT_PREVIEW_ZONE: 'context.previewZone',
  CONTEXT_MANIFEST: 'context.manifest',
  CONTEXT_SET_ZONE_ENABLED: 'context.setZoneEnabled',
  // tool
  TOOL_LIST: 'tool.list',
  TOOL_TOGGLE: 'tool.toggle',
  TOOL_BUNDLES: 'tool.bundles',
  // bundle
  BUNDLE_LIST: 'bundle.list',
  BUNDLE_CREATE: 'bundle.create',
  BUNDLE_DELETE: 'bundle.delete',
  BUNDLE_ACTIVATE: 'bundle.activate',
  BUNDLE_DEACTIVATE: 'bundle.deactivate',
  BUNDLE_ADD_TOOLS: 'bundle.addTools',
  BUNDLE_REMOVE_TOOLS: 'bundle.removeTools',
  // mcp
  MCP_LIST: 'mcp.list',
  MCP_ADD: 'mcp.add',
  MCP_REMOVE: 'mcp.remove',
  MCP_ENABLE: 'mcp.enable',
  MCP_DISABLE: 'mcp.disable',
  MCP_RECONNECT: 'mcp.reconnect',
  // plugin
  PLUGIN_LIST: 'plugin.list',
  // supervisor
  SUPERVISOR_STATUS: 'supervisor.status',
  // arch（架构监督）
  ARCH_LIST: 'arch.list',
  ARCH_GET: 'arch.get',
  ARCH_TOGGLE: 'arch.toggle',
  // companion
  COMPANION_GET: 'companion.get',
  COMPANION_ACTIVATE: 'companion.activate',
  COMPANION_DEACTIVATE: 'companion.deactivate',
  COMPANION_VOICES: 'companion.voices',
  COMPANION_VOICE_BIND: 'companion.voiceBind',
  COMPANION_VOICE_REGISTER: 'companion.voiceRegister',
  COMPANION_VOICE_DELETE: 'companion.voiceDelete',
  COMPANION_VOICE_LIST: 'companion.voiceList',
  COMPANION_VOICE_STATS: 'companion.voiceStats',
  COMPANION_VOICE_PRUNE: 'companion.voicePrune',
  COMPANION_SAY_HISTORY: 'companion.sayHistory',
  COMPANION_SCENE: 'companion.scene',
  // meta（P5-3 版本/能力协商）
  META_GET: 'meta.get',
} as const;

// ────────────────────────────────────────────────────────────
// 事件契约（P5-6：已下沉到中立层 src/events.ts）
// ────────────────────────────────────────────────────────────
// 事件是业务与 UI 的共享契约：产生者既有协议层（message.text /
// config.change…）也有业务核心（companion.say 由 AgentLoop 产生，
// companion.voice 由 TTS 流程产生）。放在协议层会让 AgentLoop 反向
// 依赖 UI 适配层，故下沉到跨层中立的 src/events.ts。
//
// 此处 re-export 仅为保持协议层对外契约完整 —— 客户端只 import
// 协议层即可拿到全部协议符号，无需知晓事件定义在别处。
// 协议层内部各域直接从 ../../events.js 引用源头。
export { UI_EVENT } from '../events.js';
export type { CompanionSayEvent, CompanionVoiceEvent } from '../events.js';

// ────────────────────────────────────────────────────────────
// 领域数据类型（与后端结构对齐，但独立定义）
// ────────────────────────────────────────────────────────────

/** 缓存命中统计（对应 backend CacheTurnRecord） */
export interface CacheStats {
  turn: number;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  hitTokens: number;
  missTokens: number;
  hitRate: number;
}

/** 状态快照 —— 对应后端 TurnInfo + provider 路由信息 */
export interface StateSnapshot {
  sessionId: string;
  /** 当前会话目录（sessionId → sessionDir 由后端 sessionStore 解析；TUI 不直读 SessionManager） */
  sessionDir?: string;
  /** 当前模型名（如 claude-3-5-sonnet） */
  model: string;
  /** 当前提供商类型（如 anthropic / deepseek） */
  provider: string;
  /** 提供商标签（展示用，如 Anthropic） */
  providerLabel?: string;
  /** 是否本地模型（ollama/llamacpp） */
  isLocal?: boolean;
  /** 路由模式：auto | manual */
  routeMode?: 'auto' | 'manual';
  /** 上下文模式：normal | companion */
  mode?: string;
  turnCount: number;
  maxTurns: number;
  tokensUsed: number;
  maxContextTokens: number;
  /** 上下文占用百分比（0-100） */
  contextUsagePct: number;
  compressCount: number;
  planStepsTotal?: number;
  planStepsDone?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  /** 当前轮次缓存命中率（0-100） */
  cacheHitRate?: number;
  /** 会话级缓存命中率**加权平均**（0-100）—— UI 主显示口径（最近一轮噪声大） */
  cacheHitRateAvg?: number;
  cacheHistory?: CacheStats[];
  /** 会话累计输入 token 总量（无 usage 字段的 provider 为 undefined） */
  totalInputTokens?: number;
  /** 会话累计输出 token 总量（无 usage 字段的 provider 为 undefined） */
  totalOutputTokens?: number;
  /** 最近一次状态更新时间（ISO） */
  updatedAt: string;
}

/** 会话元信息（对应后端 Session，省略内部 projectKey） */
export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** 开放类型：内置 normal/precise/companion，插件渠道可扩展（如 hub） */
  type?: string;
  channel?: string;
}

/** 历史消息（message.history 返回元素，对应后端 ConversationEvent） */
export interface HistoryMessage {
  /** 事件类型：user_input | text | thinking | tool_call | tool_result | error | stop | usage */
  type: string;
  /** 文本内容（text / thinking / user_input / tool_result 等） */
  content?: string;
  /** 工具名（tool_call） */
  name?: string;
  /** 事件/工具调用唯一 ID */
  id?: string;
  /** 工具调用输入（tool_call 的 input） */
  input?: Record<string, unknown>;
  /** 关联的 tool_use_id（tool_result 归属） */
  toolUseId?: string;
  /** 错误消息（error）/ 停止说明 */
  message?: string;
  /** 停止原因（stop） */
  reason?: string;
  /** token 用量（usage） */
  inputTokens?: number;
  outputTokens?: number;
  /** 事件时间戳（ISO） */
  timestamp: string;
}

/** 配置变更事件（对应 RuntimeConfigCenter 的 ConfigChangeEvent） */
export interface ConfigChangeEvent {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: string;
}

/** 配置项描述（config.schema 的返回元素） */
export interface ConfigEntry {
  /** dot-path，如 session.maxTurns */
  path: string;
  /** 值类型：string | number | boolean | string[] | object */
  type: string;
  /** 当前值 */
  value: unknown;
  /** 默认值（未覆盖时） */
  default?: unknown;
  /** 最小值（number 时） */
  min?: number;
  /** 最大值（number 时） */
  max?: number;
  /** 步进（number 时） */
  step?: number;
  /** 枚举值（有限集合时） */
  enum?: unknown[];
  /** 展示标签 */
  label?: string;
  /** 说明 */
  description?: string;
}

/** 模型通道（对应后端 ModelChannelRegistry 的 ChannelConfig + name） */
export interface ModelChannel {
  name: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  description?: string;
}

/** 本地模型条目（对应后端 ModelEntry，省略内部 path 细节） */
export interface LocalModelEntry {
  name: string;
  modelFile: string;
  backend: string;
  port?: number;
  host?: string;
  ctxSize?: number;
  nGpuLayers?: number;
  enabled: boolean;
}

/** 调度任务（schedule.list 返回元素，对应后端 ScheduledTask） */
export interface ScheduledTaskLike {
  /** 唯一标识 */
  id: string;
  /** 任务名称 */
  name: string;
  /** 调度类型：interval | cron | daily | fixed-time | random */
  scheduleType: string;
  /** 是否启用 */
  enabled: boolean;
  /** 任务所属模式（可选） */
  mode?: 'normal' | 'companion';
  /** 上次执行时间 */
  lastRunAt: string | null;
  /** 下次执行时间 */
  nextRunAt: string | null;
  /** 累计执行次数 */
  runCount: number;
  /** 出错次数 */
  errorCount: number;
  /** 标签（分组/过滤） */
  tags: string[];
  /** 目标渠道名（可选） */
  channel?: string;
}

/** 提供商就绪状态（协议层派生的语义化状态，前端直接映射展示，不做业务判断） */
export type ProviderStatus = 'active' | 'local' | 'configured' | 'unconfigured';

/** 提供商摘要 */
export interface ProviderSummary {
  /** provider 类型（anthropic / openai / ...） */
  type: string;
  /** 展示名 */
  label: string;
  /** 当前模型 */
  model: string;
  /** 是否活跃（当前启用） */
  active: boolean;
  /** 是否本地 */
  isLocal?: boolean;
  /** 能力标签 */
  capabilities?: string[];
  /** API 密钥是否已配置（envKey 对应环境变量非空；本地 provider 无 envKey 时为 true） */
  configured?: boolean;
  /** 就绪状态（协议层派生）：active=当前启用 / local=本地 / configured=已配密钥 / unconfigured=未配密钥 */
  status?: ProviderStatus;
}

/** 命令定义（对应后端 SlashCommandDef 的协议化精简） */
export interface CommandDef {
  name: string;
  description: string;
  icon?: string;
  category?: string;
  args?: string;
  argOptions?: string[];
  executeLocal?: boolean;
  deprecated?: boolean;
  /** 子命令 */
  children?: CommandDef[];
}

/** 权限请求（permission.request 事件的 payload） */
export interface PermissionRequestInfo {
  /** 请求 ID（resolve 时回填） */
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** 权限应答类型 */
export type PermissionResult = 'yes' | 'no' | 'always' | 'aor';

/** 知识库状态（kb.get 返回；对应后端 KnowledgeBase） */
export interface KnowledgeBaseState {
  /** 知识库总开关 */
  enabled: boolean;
  /** Zone 4（联网检索）开关 */
  zone4Enabled: boolean;
}

/** 后台进程信息（process.list 返回元素；对应后端 BackgroundProcessInfo） */
export interface ProcessInfoLike {
  handle: string;
  name: string;
  command: string;
  pid: number | null;
  status: 'running' | 'stopped' | 'crashed';
  startTime: string;
  outputSize: number;
}


/** 旁路 agent 编排状态（orchestrator.get 返回；对应 TUI /orchestrator） */
export interface OrchestratorState {
  /** orchestrator 旁路 agent 是否激活 */
  active: boolean;
  /** 当前激活的全部旁路 agent 名称 */
  activeAgents: string[];
}
