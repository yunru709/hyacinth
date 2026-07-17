// ============================================================
// bypass/types — 旁路Agent 接口定义
// ============================================================
//
// 旁路Agent 是独立于主Agent运行的后台观察者。
// 在主对话流的前后介入：preTurn 产出注入内容，postTurn 观察并更新内部状态。
//
// 与主Agent的差异：
//   - 独立模型通道（不抢占主Agent的上下文预算）
//   - 异常隔离（任何错误不影响主流程）
//   - 状态持久化（跨轮保持内部状态）
// ============================================================

import type { Message } from '../types.js';

// ── 上下文 ─────────────────────────────────────────────────

/** preTurn 上下文：旁路Agent在每轮对话前的输入 */
export interface PreTurnContext {
  /** 当前用户输入（原始文本） */
  userInput: string;
  /** 最近 N 轮对话原始消息 */
  recentHistory: Message[];
  /** 当前上下文预算 { used, total } */
  contextBudget: { used: number; total: number };
  /** 最近几轮的工具调用名称 */
  recentToolCalls: string[];
}

/** postTurn 上下文：旁路Agent在每轮对话后的输入 */
export interface PostTurnContext {
  /** 当前用户输入 */
  userInput: string;
  /** 主Agent的回复文本 */
  assistantOutput: string;
  /** 本轮对话历史（含用户输入和模型回复） */
  history: Message[];
  /** 本轮调用的工具名称 */
  toolCallsThisTurn: string[];
  /** 是否为本轮用户消息的最后一次迭代（loop 结束） */
  isLastIteration: boolean;
}

// ── 注入 ───────────────────────────────────────────────────

/** 注入到上下文中的 section */
export interface Injection {
  /** 目标 section 名称（如 'timestamp', 'persona_soul'） */
  section: string;
  /** 注入内容 */
  content: string;
  /** 消息角色 */
  role: 'system' | 'assistant' | 'user';
  /** 替换模式：replace=替换整个section, append=追加到末尾 */
  mode: 'replace' | 'append';
}

/** preTurn 的返回结果 */
export interface PreTurnResult {
  /** 变换后的用户输入（可选，World Engine 用于剥离 [[...]]） */
  transformedInput?: string;
  /** 要注入到上下文的 section 列表 */
  injections: Injection[];
}

// ── 旁路Agent 接口 ─────────────────────────────────────────

export interface BypassAgent {
  /** 唯一标识 */
  readonly name: string;
  /** 声明适用的模式（如 ['companion'] 或 ['*'] 表示全部） */
  readonly modes: string[];
  /** 使用的模型通道名（对应 model-channels.json 中的通道） */
  readonly modelChannel: string;

  /** 启动（创建内部状态、启动定时器等） */
  start(): Promise<void>;
  /** 停止（清理资源、落盘） */
  stop(): Promise<void>;

  /** 前置介入：在 composer 组装之前调用 */
  preTurn?(ctx: PreTurnContext): Promise<PreTurnResult>;

  /** 后置观察：在主Agent回复之后调用（后台，不影响主流程） */
  postTurn?(ctx: PostTurnContext): Promise<void>;
}
