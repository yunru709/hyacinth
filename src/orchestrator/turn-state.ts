/**
 * P1 状态收敛 · TurnState / SessionState（重构方案 §2.3 + P1-状态收敛方案.md M1）。
 *
 * 为什么需要它：loop.ts 3165 行拆不动，根因是 65 个 `private` 字段散落在 30+ 个方法之间
 * 形成隐式耦合。收敛后的形态：
 *
 *   - **TurnState**：一次迭代（一个 turn 内的一轮）的状态，在管道阶段间显式传递。
 *     阶段签名统一 `(state: TurnState, ctx: StageContext) => Promise<TurnState>`。
 *   - **SessionState**：跨回合的会话状态，挂在 loop 实例（每会话一份）。
 *   - 其余 ~22 个字段属内核服务（Provider/存储/权限链…），走 `ctx.get/require` 注入。
 *
 * 注意：本文件是**目标形状**。M3-M6 逐阶段落地时会按实际抽出代码微调字段，
 * 但"三类归属"的划分不推翻。部分字段标注了 [target]，表示抽阶段时再定细节。
 */

import type { Message, ToolCall, ToolDefinition } from '../types.js';
import type { Provider } from '../provider/interface.js';
import type { ZoneBreakdown } from '../context/composer.js';
import type { CompressionResult } from '../context/compressor.js';
import type { Injection } from '../bypass/types.js';
import type { Plan } from './plan-store.js';

// ─── 支撑类型 ──────────────────────────────────────────────────────

/** 待注入图片（view_image 工具填充，context 阶段消费） */
export interface PendingImage {
  imgId: string;
  data: string;
  media_type: string;
}

/** 流内工具执行结果（inline tool） */
export interface InlineToolResult {
  content: string;
  isError: boolean;
}

/** 单轮缓存命中记录（cacheStats.turns 元素；自 loop.ts 上移，llm 阶段写） */
export interface CacheTurnRecord {
  turn: number;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  hitTokens: number;
  missTokens: number;
  hitRate: number;
}

/** LLM 缓存统计（llm 阶段写入，TUI/UI 状态读取） */
export interface CacheStats {
  hitTokens: number;
  missTokens: number;
  /** 近期缓存命中记录（最近 N 轮） */
  turns: CacheTurnRecord[];
  logHits: boolean;
}

/** 异步子 Agent 结果（delegate-tool 写入，tools/finalize 阶段消费） */
export interface AsyncAgentResult {
  handle: string;
  agentName: string;
  status: 'completed' | 'failed';
  result?: string;
  error?: string;
}

/** 陪伴表达（companion_say 捕获，finalize 阶段 postTurn 消费） */
export interface CompanionExpression {
  text: string;
  as: 'speak' | 'think';
  tone?: string;
}

/** 工具执行结果摘要（afterToolExecute / finalize 用） */
export interface ToolExecSummary {
  name: string;
  ok: boolean;
}

// ─── 回合状态（一次迭代） ──────────────────────────────────────────

export interface TurnState {
  // ── 内核记账 ──────────────────────────────────────────────
  /** 回合计数（run() 外层维护） */
  turn: number;
  /** 是否结束迭代：tools 阶段写 true，while 循环据此退出 */
  stop: boolean;
  stopReason?: string;
  toolCalled?: boolean;

  // ── input 阶段 ────────────────────────────────────────────
  /** 原始历史（conversationStore.readAll 读入；bypass preTurn 等仍用原始历史） */
  history: Message[];
  userInput: string;
  /** 历史中是否有未消费的 tool_use（续轮判定） */
  hasPendingToolCalls: boolean;
  /** 陪伴模式旁路瞬态输入（本轮一次性，input 消费后置 null） */
  ephemeralInput: string | null;
  /** 本轮是否陪伴模式（input 阶段决定文本化路径，runTurn 预填） */
  companionMode: boolean;
  /** 剥离最后一条 user 文本后的历史（compose 的输入，M4 context 阶段消费） */
  historyWithoutLastUser: Message[];
  /** 最后一条 user 文本消息（压缩重 compose 时剥离依据，input 产出） */
  lastUserTextMsg: Message | null;
  /** 陪伴模式表达已文本化的历史（压缩器/摘要的输入，M4 消费） */
  uncompressedMsgs: Message[];
  pendingTaskNotifications: Array<{ name: string; firedAt: string }>;
  pendingTaskName: string | null;
  /** 渠道预取图片（run() 前写入，input 阶段一次性消费） */
  channelImages: Array<{ data: string; media_type: string }> | null;

  // ── bypass 阶段 ───────────────────────────────────────────
  bypassInjections: Injection[];
  /** preTurn 注入缓存（首轮建立，一次用户输入内后续迭代复用；undefined = 未 preTurn） */
  bypassInjectionsCache: Injection[] | undefined;
  /** 识别出的意图（orchestrator preTurn 产出） */
  intent: { capability: string; confidence: number } | null;
  /** 意图簇历史过滤变换 */
  historyTransform: ((msgs: Message[]) => Message[]) | null;
  /** `[CAPABILITY] xxx` 形式的意图标签（cluster 过滤用） */
  intentLabel: string | null;

  // ── context 阶段 ──────────────────────────────────────────
  toolDefinitions: ToolDefinition[];
  /** compose 产出的最终请求消息 */
  messages: Message[];
  zoneBreakdown: ZoneBreakdown;
  /** 本轮上下文 token 占用（UI state 读取） */
  lastContextTokens: number;
  summary: string | undefined;
  needsCompression: boolean;
  /** 激进压缩标记（常规压缩后仍超标 → 下轮不保护最近消息；context 阶段读写） */
  needsAggressiveCompress: boolean;
  /** 后台压缩（context 阶段消费上一轮结果） [target] */
  pendingCompression: Promise<CompressionResult | null> | null;
  /** 累计压缩次数（stats/诊断；context 阶段读写） */
  compressCount: number;
  /** 已保存摘要（summaryStore 去重：仅变更时落盘；context 阶段读写） */
  lastSavedSummary: string | undefined;
  /** 工具影响面信息（tools 阶段写，context 阶段消费） */
  impactInfo: string | null;
  /** 知识库检索 query（compose 前更新，Zone 4 读取） */
  kbQuery: string;
  pendingImageInjections: PendingImage[];
  /** 原生视频/音频待注入（view_media 产出；context 阶段按 inputTypes 门控注入） */
  pendingMediaInjections: Array<{ type: 'video' | 'audio'; media_type: string; data: string }>;
  /** 配置热更新标记（input 阶段消费） */
  contextDirty: boolean;

  // ── llm 阶段 ──────────────────────────────────────────────
  activeProvider: Provider;
  /** 本轮流式文本拼装 [target] */
  streamText: string;
  /** llm 流解析出的工具调用（tools 阶段消费） */
  toolCalls: ToolCall[];
  inlineToolExecuted: boolean;
  inlineToolResults: Map<string, InlineToolResult>;
  cacheStats: CacheStats;
  /** 本轮输入 token（USAGE 事件；未提供时 0） */
  usageInput?: number;
  /** 本轮输出 token（USAGE 事件；未提供时 0） */
  usageOutput?: number;
  /** 降级链 fallback 通知（一次性消费） */
  fallbackInfo: string | null;
  /** 降级恢复通知（一次性消费） */
  recoverInfo: string | null;

  // ── tools 阶段 ────────────────────────────────────────────
  /** 本轮工具执行摘要（结果回写后填充） */
  toolResults: ToolExecSummary[];
  pendingAsyncResults: AsyncAgentResult[];
  recentToolNames: string[];

  // ── finalize 阶段 ─────────────────────────────────────────
  companionExpressions: CompanionExpression[];
  activePlan: Plan | undefined;
  /** Flow 状态机是否仍在运行（runTurn 预填；true 时 finalize 不写 stop 事件） */
  flowStillActive: boolean;
  /**
   * say 工具状态（runTurn 预填，消费即重置）：
   *   'submitted' = 本轮已交付结论 → finalize 判停（stopReason 'say_submitted'）
   *   'aborted'   = 连续校验失败超限 → 强制结束（stopReason 'say_failed'）
   * undefined = 未提交。判定必须排在 toolCalled 之前（report 也是工具调用）。
   */
  sayStatus?: 'submitted' | 'aborted';
}

// ─── 会话状态（跨回合） ────────────────────────────────────────────

export interface SessionState {
  sessionDir: string;
  currentSummary: string | undefined;
  lastSavedSummary: string | undefined;
  activePlan: Plan | undefined;
  /** 近期工具调用（bypass preTurn 参考） */
  recentToolNames: string[];
  currentTurn: number;
  compressCount: number;
  switchingProvider: boolean;
  previousProviderWasLocal: boolean;
}

// ─── 工厂 ──────────────────────────────────────────────────────────

/** 创建一次迭代的初始 TurnState（runTurn 入口调用） */
export function createTurnState(init: {
  turn: number;
  history: Message[];
  userInput: string;
  session: SessionState;
}): TurnState {
  return {
    turn: init.turn,
    stop: false,
    history: init.history,
    userInput: init.userInput,
    hasPendingToolCalls: false,
    ephemeralInput: null,
    companionMode: false,
    historyWithoutLastUser: [],
    lastUserTextMsg: null,
    uncompressedMsgs: [],
    pendingTaskNotifications: [],
    pendingTaskName: null,
    channelImages: null,
    bypassInjections: [],
    bypassInjectionsCache: undefined,
    intent: null,
    historyTransform: null,
    intentLabel: null,
    toolDefinitions: [],
    messages: [],
    zoneBreakdown: { total: 0 },
    lastContextTokens: 0,
    summary: init.session.currentSummary,
    needsCompression: false,
    needsAggressiveCompress: false,
    pendingCompression: null,
    compressCount: 0,
    lastSavedSummary: undefined,
    impactInfo: null,
    kbQuery: '',
    pendingImageInjections: [],
    pendingMediaInjections: [],
    contextDirty: false,
    activeProvider: undefined as unknown as Provider, // [target] llm 阶段路由后填充
    streamText: '',
    toolCalls: [],
    inlineToolExecuted: false,
    inlineToolResults: new Map(),
    cacheStats: { hitTokens: 0, missTokens: 0, turns: [], logHits: false },
    fallbackInfo: null,
    recoverInfo: null,
    toolResults: [],
    pendingAsyncResults: [],
    recentToolNames: init.session.recentToolNames,
    companionExpressions: [],
    activePlan: init.session.activePlan,
    flowStillActive: false,
  };
}
