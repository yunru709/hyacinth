// ── Server → Client messages ─────────────────────────────

export interface ConnectedMsg {
  type: 'connected';
  sessionId: string;
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
  | { type: 'interrupt' };

// ── Client → Server messages ─────────────────────────────

export type ClientMessage =
  | { type: 'chat'; content: string; images?: Array<{ data: string; media_type: string }> }
  | { type: 'stop' }
  | { type: 'permission'; result: 'yes' | 'no' | 'always' }
  | { type: 'set_mode'; mode: 'normal' | 'precise' }
  | { type: 'rollback'; toTurnId: number };

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
