// ── Server → Client messages ─────────────────────────────

export type WebUIMode = 'normal' | 'precise';
export type ActivityView = 'sessions' | 'model' | 'context' | 'settings' | 'knowledge' | 'scheduler';
export type InspectorView = 'status' | 'model' | 'mode' | 'context';
export type PanelView = 'context' | 'settings' | 'models' | 'knowledge' | 'scheduler' | 'commands';

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
  | { type: 'session_switched'; sessionId: string; mode: WebUIMode };

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
  | { type: 'switch_session'; sessionId: string };

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
}

// ── Model Center types ───────────────────────────────────

export interface OnlineProviderInfo {
  name: string;
  type: string;
  description: string;
  status: 'available' | 'coming_soon';
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
