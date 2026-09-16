// ============================================================
// UI 协议层 — 状态域（state.*）
// ============================================================
// 覆盖 UI 对运行时状态的读取：
//   state.get        获取完整状态快照（模型/提供商/模式/token/
//                    上下文占用/缓存命中/plan 进度/压缩次数）
//   state.subscribe  订阅状态更新（state.update 事件）
//   state.unsubscribe 取消订阅
//
// StateSnapshot 由三部分组装：
//   1. TurnInfo（turnCount/tokensUsed/contextUsage/cache/plan）
//   2. provider 路由信息（providerLabel/isLocal/mode）
//   3. 当前 active provider（provider type / model）
//
// 依赖结构化 LoopLike 接口（真实 AgentLoop 天然兼容），可独立测试。
// ============================================================

import type { DomainHandler } from '../server.js';
import type { StateSnapshot, CacheStats } from '../types.js';

// ────────────────────────────────────────────────────────────
// 结构化 Loop 接口（AgentLoop 兼容）
// ────────────────────────────────────────────────────────────

/** 后端 TurnInfo（对应 orchestrator/loop.ts 的 TurnInfo） */
export interface TurnInfoLike {
  turnCount: number;
  maxTurns: number;
  tokensUsed: number;
  maxContextTokens: number;
  planStepsTotal?: number;
  planStepsDone?: number;
  sessionId: string;
  compressCount: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheHitRate?: number;
  /** 会话级缓存命中率加权平均（0-100） */
  cacheHitRateAvg?: number;
  cacheHistory?: CacheStats[];
  /** 会话累计输入 token 总量（无 usage 字段的 provider 为 undefined） */
  totalInputTokens?: number;
  /** 会话累计输出 token 总量（无 usage 字段的 provider 为 undefined） */
  totalOutputTokens?: number;
}

/** provider 路由信息（对应 loop.getProviderRoutingInfo 返回） */
export interface RoutingInfoLike {
  providerLabel: string;
  isLocal: boolean;
  mode: string;
}

/** active provider 视图 */
export interface ActiveProviderLike {
  getProviderType(): string;
  getModel(): string;
}

/** AgentLoop 最小接口（state/message 域共享） */
export interface LoopLike {
  /** 获取当前回合状态信息 */
  getTurnInfo(turnCount: number, tokensUsed: number): TurnInfoLike;
  /** provider 路由信息（可能为 null） */
  getProviderRoutingInfo(): RoutingInfoLike | null;
  /** 当前活跃 provider */
  getActiveProvider(): ActiveProviderLike;
  /** 运行一轮对话（message.chat 用，可选） */
  run?(content: string): Promise<void>;
  /** 中断当前回合（message.stop 用，可选） */
  interrupt?(): void;
  /** 切换主 provider（model.switch 用，可选；真实 AgentLoop.switchProvider） */
  switchProvider?(providerName: string, model?: string): Promise<void>;
  /** 循环切换主 provider（model.toggle 用，可选；真实 AgentLoop.toggleProvider） */
  toggleProvider?(): void;
  /** 切换当前会话目录（session.switch 用，可选；真实 AgentLoop.switchSession） */
  switchSession?(newSessionDir: string): Promise<void>;
  /** 各角色模型来源（model.sources 用，可选；真实 AgentLoop.getModelSources） */
  getModelSources?(): Record<string, 'main' | 'local'> | null;
  /** 当前正在执行的调度任务名（schedule.runtime 用，可选；真实 AgentLoop.pendingTaskName） */
  pendingTaskName?: string | null;
  /** 当前上下文 token 占用（真实 AgentLoop.contextTokensUsed getter；优先于 tokensUsed 参数） */
  contextTokensUsed?: number;
  /** 当前回合号（真实 AgentLoop.turnNumber getter；优先于 turnCount 参数） */
  turnNumber?: number;
}

// ────────────────────────────────────────────────────────────
// 状态快照组装
// ────────────────────────────────────────────────────────────

/** 计算上下文占用百分比（0-100，1 位小数） */
export function calcContextUsagePct(tokensUsed: number, maxContextTokens: number): number {
  if (!maxContextTokens || maxContextTokens <= 0) return 0;
  return Math.round((Math.min(tokensUsed, maxContextTokens) / maxContextTokens) * 1000) / 10;
}

/**
 * 组装完整状态快照。
 * 由 loop 的 turnInfo + routing + activeProvider 三部分合并。
 */
export function buildStateSnapshot(
  loop: LoopLike,
  turnCount: number,
  tokensUsed: number,
  sessionDirProvider?: (sessionId: string) => string | undefined,
): StateSnapshot {
  // 优先用 loop 内部的真实运行时值（contextTokensUsed/turnNumber getter），
  // 缺失时回退到装配层传入的参数（测试 mock / 非 AgentLoop 后端）。
  const realTokens = loop.contextTokensUsed != null ? loop.contextTokensUsed : tokensUsed;
  const realTurn = loop.turnNumber != null ? loop.turnNumber : turnCount;
  const info = loop.getTurnInfo(realTurn, realTokens);
  const routing = loop.getProviderRoutingInfo();
  const active = loop.getActiveProvider();

  return {
    sessionId: info.sessionId,
    // sessionId → sessionDir 由后端 sessionStore 解析（TUI 不直读 SessionManager）
    ...(sessionDirProvider ? { sessionDir: sessionDirProvider(info.sessionId) } : {}),
    model: active.getModel(),
    provider: active.getProviderType(),
    // providerLabel 语义应为「provider 类型展示名」（如 deepseek / anthropic），
    // 而非 providerRouter 的通道名（如 main）。active.getProviderType() 是真实来源。
    providerLabel: active.getProviderType(),
    isLocal: routing?.isLocal ?? false,
    routeMode: routing?.mode === 'auto' ? 'auto' : 'manual',
    mode: routing?.mode,
    turnCount: info.turnCount,
    maxTurns: info.maxTurns,
    tokensUsed: info.tokensUsed,
    maxContextTokens: info.maxContextTokens,
    contextUsagePct: calcContextUsagePct(info.tokensUsed, info.maxContextTokens),
    compressCount: info.compressCount,
    planStepsTotal: info.planStepsTotal,
    planStepsDone: info.planStepsDone,
    cacheHitTokens: info.cacheHitTokens,
    cacheMissTokens: info.cacheMissTokens,
    cacheHitRate: info.cacheHitRate,
    cacheHitRateAvg: info.cacheHitRateAvg,
    cacheHistory: info.cacheHistory,
    totalInputTokens: info.totalInputTokens,
    totalOutputTokens: info.totalOutputTokens,
    updatedAt: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────
// 状态域选项
// ────────────────────────────────────────────────────────────

export interface StateDomainOptions {
  loop: LoopLike;
  /** 当前回合计数提供者（缺省 0） */
  turnCount?: () => number;
  /** 当前 token 使用提供者（缺省 0） */
  tokensUsed?: () => number;
  /** 订阅者集合（用于 state.subscribe 的推送；绑定到 server 的事件推送） */
  emit?: (type: string, payload?: unknown) => void;
  /** 会话统计提供者（state.stats 用；由桥接层注入 StatsManager 读取，可选） */
  statsProvider?: (sessionId: string) => Promise<unknown>;
  /** 会话目录提供者（state.get 快照的 sessionDir 用；由桥接层注入 sessionStore.getSessionDir，可选） */
  sessionDirProvider?: (sessionId: string) => string | undefined;
}

// ────────────────────────────────────────────────────────────
// 状态域工厂
// ────────────────────────────────────────────────────────────

export function createStateDomain(options: StateDomainOptions): DomainHandler {
  const { loop, turnCount = () => 0, tokensUsed = () => 0, statsProvider, sessionDirProvider } = options;

  return {
    // ── state.get ─────────────────────────────────────────
    get: () => buildStateSnapshot(loop, turnCount(), tokensUsed(), sessionDirProvider),

    // ── state.subscribe ───────────────────────────────────
    subscribe: () => {
      // 订阅通过事件推送实现；subscribe 成功后立即回传当前快照
      // （客户端据此渲染初始状态）。后续 state.update 事件由
      // 上层（消息域 turn_info 后）触发。
      return { ok: true, snapshot: buildStateSnapshot(loop, turnCount(), tokensUsed(), sessionDirProvider) };
    },

    // ── state.unsubscribe ─────────────────────────────────
    unsubscribe: () => {
      // 订阅管理由传输层/客户端自行处理；此处返回 ok 占位。
      return { ok: true };
    },

    // ── state.stats ───────────────────────────────────────
    async stats(params: unknown): Promise<{ sessionId: string; stats: unknown }> {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) throw new Error('state.stats requires "sessionId"');
      if (!statsProvider) {
        throw new Error('state.stats not supported (statsProvider not wired)');
      }
      const stats = await statsProvider(sessionId);
      return { sessionId, stats };
    },
  };
}
