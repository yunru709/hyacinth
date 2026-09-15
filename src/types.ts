// === Message 相关 ===
export type MessageRole = 'system' | 'user' | 'assistant';

export interface TextContent {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

/**
 * 泛化媒体源（多模态视频/音频输入）。
 * ImageSource 兼容：同构 + file 本地引用分支（大媒体：发送时由管线解析为内联/抽帧）。
 */
export type MediaSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'file'; path: string };

export interface ImageContent {
  type: 'image';
  source: ImageSource;
  cache_control?: { type: 'ephemeral' };
}

/** 视频内容块（模型支持 video 输入时发送；sampling 为请求提示，非硬约束） */
export interface VideoContent {
  type: 'video';
  source: MediaSource;
  media_type: string;
  sampling?: { fps?: number; max_frames?: number; max_long_side_pixel?: number };
  cache_control?: { type: 'ephemeral' };
}

/** 音频内容块 */
export interface AudioContent {
  type: 'audio';
  source: MediaSource;
  media_type: string;
  cache_control?: { type: 'ephemeral' };
}

export type MessageContent = TextContent | ThinkingContent | ToolUseContent | ToolResultContent | ImageContent | VideoContent | AudioContent;

export interface Message {
  role: MessageRole;
  content: MessageContent | MessageContent[];
  /** 所属意图簇 ID（旁路 orchestrator 归类后回填，用于按意图过滤历史） */
  _cluster_id?: string;
  /** 被簇级压缩的标记（方案 3.6/决策C：压缩不丢弃，追加标记；仅保留最近一次压缩记录） */
  _compressed?: {
    /** 所属意图簇 capability（coding/chat/tool_use...） */
    intent: string;
    /** 压缩后摘要的 hash（用于去重/追溯） */
    summary_hash: string;
    /** 压缩时间 ISO 字符串 */
    compressed_at: string;
  };
}

// === Tool 相关 ===
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// === Stream Event 相关 ===
export type StreamEventType = 'TEXT' | 'THINKING' | 'TOOL_USE' | 'IMAGE' | 'USAGE' | 'STOP';

export type StreamEvent =
  | { type: 'TEXT'; content: string }
  | { type: 'THINKING'; content: string }
  | { type: 'TOOL_USE'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'IMAGE'; source: ImageSource }
  | { type: 'USAGE'; input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_hit_tokens?: number; cache_miss_tokens?: number }
  | { type: 'STOP'; reason: string };

// === Session 相关 ===

/**
 * 会话类型 —— 开放可扩展：
 * 内置 normal / precise / companion 三种，插件/渠道可声明新类型（如 hub）。
 * 用 `(string & {})` 保留字符串字面量提示，同时允许任意扩展名。
 */
export type SessionType = 'normal' | 'precise' | 'companion' | (string & {});

/** 内置会话类型常量（供代码引用，避免魔法字符串） */
export const SESSION_TYPE_NORMAL = 'normal';
export const SESSION_TYPE_PRECISE = 'precise';
export const SESSION_TYPE_COMPANION = 'companion';

export interface Session {
  id: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
  type?: SessionType;
  /** 创建此 session 的渠道：'webui' | 'tui' | 'feishu' 等 */
  channel?: string;
}

export interface SessionStats {
  input_tokens: number;
  output_tokens: number;
  turn_count: number;
  compact_count: number;
  current_context_tokens: number;
  /** 每轮缓存命中记录（用于分析前缀缓存稳定性） */
  cache_turns?: Array<{
    turn: number;
    timestamp: string;
    inputTokens: number;
    outputTokens: number;
    hitTokens: number;
    missTokens: number;
    hitRate: number;
  }>;
}

// === Provider 相关 ===
// ProviderType 由 factory-registry 注册表键派生（P5-15，方案 C）——
// 手写 16 值联合已删除，新增厂商只改注册表一处，类型自动收敛。
// import + re-export 均为 type-only，不引入运行时依赖（本文件保持纯类型中立层）。
import type { ProviderType } from './provider/factory-registry.js';
export type { ProviderType } from './provider/factory-registry.js';

export interface ProviderConfig {
  // type 放宽为 string：B-3 后运行时 registerProviderFactory 可注册内置 ProviderType
  // 之外的厂商（内置厂商仍由 ProviderType 联合 + Record 注解编译期守卫）
  type: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** 单次请求最大输出 token 数。不传则从模型目录/Provider 配置中自动获取。 */
  maxOutputTokens?: number;
  /** DeepSeek KVCache 隔离 ID。不同角色应使用不同的 userId 避免缓存互相污染。 */
  userId?: string;
  /** 通用字段（userId/采样参数等；工厂层归一 userId 进 fields） */
  fields?: ProviderFields;
  /** 采样参数（temperature/topP/frequencyPenalty/presencePenalty；让配置生效） */
  sampling?: ProviderSampling;
}

import type { ProviderFields, ProviderSampling } from './provider/fields.js';
export type { ProviderFields, ProviderSampling } from './provider/fields.js';

// === 依赖图谱 STUB ===
export interface FilePosition {
  file: string;
  line: number;
  column?: number;
}

export interface SymbolReference {
  symbol: string;
  kind: 'variable' | 'function' | 'class' | 'import' | 'type';
  definedAt: FilePosition;
  references: FilePosition[];
}

export interface ChangeImpact {
  modifiedSymbols: SymbolReference[];
  affectedFiles: string[];
  affectedReferences: FilePosition[];
  riskLevel: 'low' | 'medium' | 'high';
  recommendation: string;
}

// === MCP 相关 ===
export interface MCPConfig {
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
  /** 包类型："npm" | "python"，指定则需要框架统一安装 */
  packageType?: 'npm' | 'python';
  /** npm/python 包名 */
  package?: string;
  /** 目标版本，省略则用 latest */
  packageVersion?: string;
  /** 连接超时（毫秒），默认 30000 */
  connectTimeout?: number;
  /** 工具调用超时（毫秒），默认 60000 */
  callTimeout?: number;
}

// === Skill 相关 ===
export interface SkillDefinition {
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

// === Sub-Agent 相关 ===

export interface AgentDefinition {
  /** 唯一标识符 */
  name: string;
  /** 运行时实例 ID（支持同一 name 的多实例分身，自动生成） */
  instanceId?: string;
  /** 角色描述，供主 Agent 判断何时使用该子 Agent */
  description: string;
  /** 系统提示词模板（支持 {{task}} 占位符，首次委派时解析为固定指引；任务经 user 消息传递） */
  systemPrompt: string;
  /** 工具白名单（空数组表示允许所有工具） */
  allowedTools: string[];
  /** 可选的模型偏好 */
  modelPreference?: string;
  /** 该子 Agent 的最大执行轮次 */
  maxTurns: number;
  /** 输出格式（默认 text） */
  outputFormat?: 'text' | 'json';
  /** JSON 模式的输出 schema */
  outputSchema?: Record<string, unknown>;
  /** 子 Agent 会话 TTL（分钟），超时未调用则自动清理重建。默认 10 */
  sessionTtlMinutes?: number;
}

export interface AgentResult {
  /** 子 Agent 名称 */
  agentName: string;
  /** 分配的任务 */
  task: string;
  /** 执行状态 */
  status: 'completed' | 'max_turns_reached' | 'error';
  /** 执行摘要 */
  summary: string;
  /** 实际执行轮次 */
  turns: number;
  /** 修改的文件列表 */
  filesModified: string[];
}
