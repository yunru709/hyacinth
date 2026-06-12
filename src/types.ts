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

export interface ImageContent {
  type: 'image';
  source: ImageSource;
  cache_control?: { type: 'ephemeral' };
}

export type MessageContent = TextContent | ThinkingContent | ToolUseContent | ToolResultContent | ImageContent;

export interface Message {
  role: MessageRole;
  content: MessageContent | MessageContent[];
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
export interface Session {
  id: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
  type?: 'normal' | 'precise';
}

export interface SessionStats {
  input_tokens: number;
  output_tokens: number;
  turn_count: number;
  compact_count: number;
  current_context_tokens: number;
}

// === Provider 相关 ===
export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'local'
  | 'llamacpp'
  | 'ollama'
  | 'groq'
  | 'xai'
  | 'mistral'
  | 'openrouter'
  | 'gemini'
  | 'moonshot'
  | 'qwen'
  | 'zhipu'
  | 'minimax'
  | 'mimo';

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

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
export type CollaborationMode = 'delegate' | 'adversarial' | 'parallel';

export interface AgentDefinition {
  /** 唯一标识符 */
  name: string;
  /** 运行时实例 ID（支持同一 name 的多实例分身，自动生成） */
  instanceId?: string;
  /** 角色描述，供主 Agent 判断何时使用该子 Agent */
  description: string;
  /** 系统提示词模板（支持 {{task}} 占位符） */
  systemPrompt: string;
  /** 工具白名单（空数组表示允许所有工具） */
  allowedTools: string[];
  /** 可选的模型偏好 */
  modelPreference?: string;
  /** 该子 Agent 的最大执行轮次 */
  maxTurns: number;
  /** 协作模式 */
  collaborationMode: CollaborationMode;
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
