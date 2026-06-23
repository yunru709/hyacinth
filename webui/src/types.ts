// ── Server → Client messages ─────────────────────────────

export type WebUIMode = 'normal' | 'precise';
export type ActivityView = 'sessions' | 'model' | 'context' | 'settings' | 'knowledge' | 'scheduler' | 'workflow';
export type InspectorView = 'status' | 'model' | 'mode' | 'context';
export type PanelView = 'context' | 'settings' | 'models' | 'knowledge' | 'scheduler' | 'commands' | 'workflow';

// ── Config types for settings panel ──────────────────────

export interface ContextConfig {
  compressThreshold: number;
  emergencyThreshold: number;
  compressDepth: number;
  compressionStrategy: 'A' | 'C';
}

export interface RepairConfig {
  scavenge: { enabled: boolean };
  storm: { enabled: boolean; windowSize: number; threshold: number };
}

export interface SafetyConfig {
  requireConfirmation: boolean;
  dangerousTools: string[];
  allowedTools: string[];
  allowedCommands: string[];
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error' | 'off';
}

export interface WebUIConfig {
  maxTurns: number;
  maxContext: number;
  context: ContextConfig | null;
  repair: RepairConfig | null;
  safety: SafetyConfig | null;
  logging: LoggingConfig | null;
  provider?: { enableThinking?: boolean; thinkingEffort?: string | number | null; showThinking?: boolean };
  kb?: { enabled?: boolean; zone4?: boolean };
}

export interface ConnectedMsg {
  type: 'connected';
  sessionId: string;
  mode: WebUIMode;
  config: SessionConfig;
}

export interface SessionConfig {
  cwd: string;
  provider: string;
  model: string;
  maxTurns: number;
  maxContext: number;
  personaDir: string;
}

export interface TextMsg {
  type: 'text';
  content: string;
}

export interface ThinkingMsg {
  type: 'thinking';
  content: string;
}

export interface ToolUseMsg {
  type: 'tool_use';
  id: string;
  name: string;
  inputSummary: string;
}

export interface ToolResultMsg {
  type: 'tool_result';
  id: string;
  content: string;
  isError: boolean;
}

export interface DiffMsg {
  type: 'diff';
  id: string;
  filePath: string;
  diffLines: Array<{ kind: string; text: string }>;
}

export interface StatusMsg {
  type: 'status';
  message: string;
  level: 'info' | 'warn' | 'error';
  mode?: WebUIMode;
  sessionId?: string;
}

export interface TurnInfoMsg {
  type: 'turn_info';
  turnCount: number;
  maxTurns: number;
  tokensUsed: number;
  maxTokens: number;
  cacheHitRate: number | null;
  compressCount: number;
  providerLabel?: string;
  isLocal?: boolean;
}

export interface PermissionRequestMsg {
  type: 'permission';
  toolName: string;
  input: Record<string, unknown>;
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | ConnectedMsg
  | TextMsg
  | ThinkingMsg
  | ToolUseMsg
  | ToolResultMsg
  | DiffMsg
  | StatusMsg
  | TurnInfoMsg
  | PermissionRequestMsg
  | ErrorMsg
  | { type: 'turn_start' }
  | { type: 'flush' }
  | { type: 'interrupt' }
  | { type: 'session_switched'; sessionId: string; mode: WebUIMode }
  | { type: 'model_status'; provider: string; model: string }
  | { type: 'queue_updated'; items: QueuedMessage[] };

// ── REST API: Session history events ────────────────────

export interface ConversationEvent {
  type: 'user_input' | 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'stop' | 'usage';
  content?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  message?: string;
  reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  timestamp: string;
}

// ── Client → Server messages ─────────────────────────────

export type ClientMessage =
  | { type: 'chat'; content: string; images?: Array<{ data: string; media_type: string }> }
  | { type: 'stop' }
  | { type: 'permission'; result: 'yes' | 'no' | 'always' }
  | { type: 'set_mode'; mode: WebUIMode }
  | { type: 'rollback'; toTurnId: number }
  | { type: 'switch_session'; sessionId: string }
  | { type: 'switch_provider'; provider: string }
  | { type: 'switch_model'; model: string }
  | { type: 'queue_message'; content: string }
  | { type: 'queue_insert'; content: string }
  | { type: 'queue_remove'; id: string }
  | { type: 'queue_clear' };

// ── Chat message nodes ───────────────────────────────────

export type MessageNode =
  | UserMsgNode
  | TextMsgNode
  | ThinkingMsgNode
  | ToolCallNode
  | SystemMsgNode;

export interface UserMsgNode {
  kind: 'user';
  content: string;
  id: string;
  /** 这条消息属于第几个回合（用于回滚定位） */
  turnId: number;
}

export interface TextMsgNode {
  kind: 'text';
  content: string;
  id: string;
}

export interface ThinkingMsgNode {
  kind: 'thinking';
  content: string;
  id: string;
  collapsed: boolean;
}

export interface ToolCallNode {
  kind: 'tool';
  id: string;
  name: string;
  inputSummary: string;
  result?: string;
  isError?: boolean;
  diff?: { filePath: string; diffLines: Array<{ kind: string; text: string }> };
  expanded: boolean;
}

export interface SystemMsgNode {
  kind: 'system';
  content: string;
  level: 'info' | 'warn' | 'error';
  id: string;
}

// ── REST API types ───────────────────────────────────────

export interface SessionInfo {
  id: string;
  createdAt: string;
  updatedAt?: string;
  type?: string;
  channel?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  schema: Record<string, unknown> | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: string;
}

export interface AgentInfo {
  name: string;
  description: string;
}

export interface WorkflowInfo {
  name: string;
  description: string;
  source?: string;
  triggerKeywords?: string[];
  relatedTools?: string[];
}

export interface WorkflowStepInfo {
  id: number;
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  reason?: string;
}

export interface WorkflowStatus {
  active: boolean;
  name: string | null;
  description: string | null;
  phase: string | null;
  steps: WorkflowStepInfo[];
  data: Record<string, unknown>;
  startedAt: string | null;
}

// ── Workflow Graph Editor types ─────────────────────────
// 与后端 workflow JSON 对齐，支持无限子图嵌套

/** 节点类型 — 与设计文档对齐 */
export type WorkflowNodeType =
  | 'start'        // 开始节点
  | 'end'          // 结束节点
  | 'agent'        // Agent 节点（核心）
  | 'tool'         // 工具调用
  | 'context'      // 上下文注入
  | 'compressor'   // 压缩器
  | 'prompt'       // 提示词模板
  | 'transform'    // 数据转换
  | 'branch'       // 条件分支
  | 'loop'         // 循环
  | 'parallel'     // 并行执行
  | 'input'        // 输入端口
  | 'output'       // 输出端口
  | 'subworkflow'  // 子工作流（复合节点，可展开）
  | 'note';        // 注释节点

/** 节点端口定义 */
export interface NodePort {
  id: string;
  label: string;
  type: 'input' | 'output';
}

/** 图节点数据 */
export interface GraphNodeData {
  label: string;
  description?: string;
  nodeType: WorkflowNodeType;
  config?: Record<string, unknown>;
  /** 仅 subworkflow 类型 — 内嵌子图（inline 模式） */
  subgraph?: WorkflowGraph;
  /** 仅 subworkflow 类型 — 引用外部工作流名（reference 模式） */
  subworkflowRef?: string;
  /** 端口定义（可选，默认按 nodeType 自动生成） */
  ports?: NodePort[];
}

/** React Flow 节点 */
export interface WorkflowGraphNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: GraphNodeData;
}

/** React Flow 边 */
export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  animated?: boolean;
}

/** 工作流图 — 可无限嵌套 */
export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  metadata?: {
    name?: string;
    description?: string;
    version?: string;
  };
}

/** 面包屑路径项（子图展开时使用） */
export interface GraphBreadcrumb {
  nodeId: string;
  label: string;
}

/** 节点类型元信息（用于面板注册） */
export interface NodeTypeMeta {
  type: WorkflowNodeType;
  label: string;
  category: 'control' | 'agent' | 'data' | 'composite' | 'annotation';
  icon: string;
  color: string;
  description: string;
  hasSubgraph: boolean;
}

// ── Model Center types ───────────────────────────────────

export interface OnlineProviderInfo {
  /** provider 类型标识，如 anthropic / openai / deepseek */
  type: string;
  name: string;
  description: string;
  status: 'available' | 'coming_soon';
}

export interface LocalModelDetectResult {
  detected: { backend: string; baseUrl: string; port: number } | null;
  ollamaInstalled: boolean;
  ollamaPath: string | null;
  llamacppInstalled: boolean;
  llamacppPath: string | null;
  registeredModels: string[];
}

export interface QueuedMessage {
  id: string;
  content: string;
  mode: 'queue' | 'insert';
}

export interface LocalModelStatus {
  detected: boolean;
  backend: string | null;
  running: boolean;
  registeredModels: string[];
  note: string;
}

export interface ThinkingSettings {
  enableThinking: boolean;
  thinkingEffort: string | number | null;
  showThinking: boolean;
  note: string;
}

export interface ModelChannelInfo {
  name: string;
  provider: string;
  model: string;
  description?: string;
  roles: string[];
}

export interface ModelStatus {
  provider: string;
  model: string;
  routing: {
    mode: string;
    isLocal: boolean;
  };
  onlineProviders: OnlineProviderInfo[];
  localModel: LocalModelStatus;
  thinking: ThinkingSettings;
  channels: ModelChannelInfo[];
  roleMappings: Record<string, string>;
  note: string;
}

// ── Scheduler types ──────────────────────────────────────

export type ScheduleType = 'interval' | 'cron' | 'daily' | 'fixed-time' | 'random';

export interface ScheduledTask {
  id: string;
  name: string;
  scheduleType: ScheduleType;
  schedule: Record<string, unknown>;
  action: { type: string; target: string; payload?: Record<string, unknown> };
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  errorCount: number;
  tags: string[];
}

export interface SchedulerStatus {
  running: boolean;
  startedAt: string | null;
  taskCount: number;
  enabledTaskCount: number;
  recentExecutions: unknown[];
  uptime: number | null;
}

export interface TaskExecutionRecord {
  taskId: string;
  taskName: string;
  executedAt: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface CommandItem {
  id: string;
  label: string;
  description: string;
  category?: string;
}
