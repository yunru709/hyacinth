// ============================================================
// WebUI 协议类型定义
// ============================================================
//
// Client ↔ Server 消息类型。
// 前端通过 WebSocket 发送 ClientMessage，接收 ServerMessage。
// 与 OutputHandler 回调一一对应。
// ============================================================

// ── Client → Server ─────────────────────────────────────────

export type WebUIClientMessage =
  | WebUIChatMessage
  | WebUIStopMessage
  | WebUIPermissionResponse
  | WebUISetModeMessage;

export interface WebUIChatMessage {
  type: 'chat';
  content: string;
  images?: Array<{ data: string; media_type: string }>;
}

export interface WebUIStopMessage {
  type: 'stop';
}

export interface WebUIPermissionResponse {
  type: 'permission';
  result: 'yes' | 'no' | 'always';
}

export interface WebUISetModeMessage {
  type: 'set_mode';
  mode: 'normal' | 'precise';
}

// ── Server → Client ─────────────────────────────────────────

export type WebUIServerMessage =
  | WebUIConnectedMessage
  | WebUITextMessage
  | WebUIThinkingMessage
  | WebUIToolUseMessage
  | WebUIToolResultMessage
  | WebUIDiffMessage
  | WebUIStatusMessage
  | WebUITurnStartMessage
  | WebUIFlushMessage
  | WebUIInterruptMessage
  | WebUITurnInfoMessage
  | WebUIPermissionRequestMessage
  | WebUIErrorMessage;

/** 连接成功 + session 初始化信息 */
export interface WebUIConnectedMessage {
  type: 'connected';
  sessionId: string;
  config: WebUISessionConfig;
}

export interface WebUISessionConfig {
  cwd: string;
  provider: string;
  model: string;
  maxTurns: number;
  maxContext: number;
  personaDir: string;
}

export interface WebUITextMessage {
  type: 'text';
  content: string;
}

export interface WebUIThinkingMessage {
  type: 'thinking';
  content: string;
}

export interface WebUIToolUseMessage {
  type: 'tool_use';
  id: string;
  name: string;
  inputSummary: string;
}

export interface WebUIToolResultMessage {
  type: 'tool_result';
  id: string;
  content: string;
  isError: boolean;
}

export interface WebUIDiffMessage {
  type: 'diff';
  id: string;
  filePath: string;
  diffLines: Array<{ kind: string; text: string }>;
}

export interface WebUIStatusMessage {
  type: 'status';
  message: string;
  level: 'info' | 'warn' | 'error';
}

export interface WebUITurnStartMessage {
  type: 'turn_start';
}

export interface WebUIFlushMessage {
  type: 'flush';
}

export interface WebUIInterruptMessage {
  type: 'interrupt';
}

export interface WebUITurnInfoMessage {
  type: 'turn_info';
  turnCount: number;
  maxTurns: number;
  tokensUsed: number;
  maxTokens: number;
  cacheHitRate: number | null;
  /** 活跃 workflow 名称 */
  workflowName?: string | null;
  /** workflow 进度 */
  workflowStep?: string | null;
  /** 压缩次数 */
  compressCount: number;
  /** Provider 标签 */
  providerLabel?: string;
  /** 是否本地模型 */
  isLocal?: boolean;
}

export interface WebUIPermissionRequestMessage {
  type: 'permission';
  toolName: string;
  input: Record<string, unknown>;
}

export interface WebUIErrorMessage {
  type: 'error';
  message: string;
}
