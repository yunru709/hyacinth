import type { Provider } from '../provider/interface.js';
import type { ProviderRouter } from '../provider/router.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { ModelRole } from '../provider/model-router.js';
import { ProviderManager } from '../provider/manager.js';
import { getModelInfo } from '../provider/catalog.js';
import { LocalProvider } from '../provider/local.js';
import { LayeredContextComposer } from '../context/composer.js';
import { CompressorOrchestrator, type CompressionResult } from '../context/compressor.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConversationStore } from '../memory/conversation.js';

import type { EventStore } from '../memory/events.js';
import { appendEvent } from '../memory/events.js';
import type { StatsManager } from '../memory/stats.js';
import type { SummaryStore } from '../memory/summary.js';
import type { Message, MessageContent, ToolCall, TextContent, ThinkingContent, ToolUseContent, ToolResultContent } from '../types.js';
import { LLMOrchestrator } from './planner.js';
import type { Plan } from './plan-store.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { MCPBridge } from '../mcp/bridge.js';
import type { DependencyAnalyzer } from '../dependency/analyzer.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { LifecycleSupervisor } from '../supervisor/shutdown.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { UI_EVENT, type CompanionSayEvent } from '../events.js';
import { nextSayId } from '../tools/companion-say.js';
import { getSayHistoryStore } from '../companion/say-history.js';
import { ImageStore, buildUserContentWithMedia, buildUserContentWithInlineImages, createViewImageTool, createViewMediaTool } from '../multimodal/index.js';
import { createLoopHookBus, type LoopHookBus, type LoopHooks } from './loop-hooks.js';
import { type ToolExecContext } from './loop-tools.js';
import { removeLastRoundFromJsonl, cleanCompanionJsonl, removeTriggerFromJsonl } from './loop-session.js';
import { maybeCompressCluster, loadClusterIndex, type ClusterDeps, type ClusterIndexEntry } from './loop-cluster.js';
import { toggleProvider, switchProvider, tryCreateProviderFromConfig, subscribeConfig, switchToAutoRoute, getProviderRoutingInfo, setModelSource, getModelSources } from './loop-provider.js';
import { createTurnState, type TurnState, type SessionState, type CacheTurnRecord } from './turn-state.js';
import { averageHitRate, formatCacheDisplay } from './cache-rate.js';
import { Pipeline, type SlotSpec } from '../kernel/pipeline.js';
import { createKernel, DEFAULT_PIPELINE_SLOTS, type KernelComponents } from './create-kernel.js';
import { StageServiceMap, StageServiceKey, KernelStageContext } from './stage-services.js';
import { createToolService, type ToolService } from './tool-service.js';
import { createClusterService, type ClusterService, type DeepCompressState } from './cluster-service.js';
import { recycleProcessedImages as recycleImagesFromHistory } from './loop-image.js';
import { PluginHost, type HyPlugin } from '../kernel/plugin-host.js';
import type { Disposable } from '../kernel/types.js';
import { createLogger } from '../logging/logger.js';
import type { MachineRegistry } from '../machine/registry.js';
import { isFlowTool } from '../tools/flow.js';
import { HeartbeatScheduler } from '../schedule/scheduler.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../setup/config.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import { mainUserId } from '../provider/user-id.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import type { SafetyConfig } from '../setup/config.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { LoopGuard, isMutating, ToolGuard } from '../repair/loop-guard.js';
import { deriveDangerousTools } from '../tools/side-effect.js';
import { ToolResultBuffer } from '../tools/result-buffer.js';
import { sanitizeToolResult } from '../tools/injection-filter.js';
import { getActiveRouter, getRouterForChannel, channelKeyOf, type ContextProfile } from '../context/profiles.js';
import type { IContextRouter } from '../context/router.js';
import { NormalRouter } from '../context/router.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { GitManager } from '../evolution/git-manager.js';
import { extractTextContent, hasTextContent, hasToolUseContent, formatTimestamp, computeProtectCount } from '../utils/misc.js';
import type { TurnRecorder } from '../rollback/turn-recorder.js';
import * as sessionAllowlist from '../tools/session-allowlist.js';

// ─── Output handler interface ───────────────────────────────────────

/** Decoupled output interface — CLI and TUI implement this */
export interface OutputHandler {
  onText?(content: string): void;
  onThinking?(content: string): void;
  onToolUse?(name: string, inputSummary: string, toolId?: string): void;
  onToolResult?(content: string, isError: boolean, toolId?: string): void;
  onDiff?(toolId: string, filePath: string, diffLines: Array<{ kind: string; text: string }>): void;
  onStatus?(message: string, level: 'info' | 'warn' | 'error'): void;
  onTurnStart?(): void;
  onFlush?(): void;
  /** 用户中断：清理动画和临时状态 */
  onInterrupt?(): void;
  /** Request user permission for dangerous tool execution. Returns 'yes' (once), 'no' (deny), 'always' (tool allowlisted — session-scoped), or 'aor' (all tools unrestricted — session-scoped). Persistent allowlisting goes through the allow_tool tool (global config). */
  onPermissionRequest?(toolName: string, input: Record<string, unknown>): Promise<'yes' | 'no' | 'always' | 'aor'>;
  /** Ask the user structured questions with options. Each question supports multi-select and custom input.
   *  Returns a JSON string mapping question index → selected answers. */
  onAskUser?(questions: AskUserQuestion[]): Promise<string>;
  /** say 工具交付内容（模型的"嘴"）。可选：实现方可用不同样式渲染，
   *  未实现时回退 onText（见 takeSayStatus）。 */
  onSay?(content: string): void;
  /** 通用事件通道（陪伴语音等非 message 正文的后端推送；协议层转发给 UI） */
  onEvent?(type: string, payload?: unknown): void;
}

/** A single question for ask_user */
export interface AskUserQuestion {
  question: string;
  header?: string;
  options?: string[];
  multiSelect?: boolean;
  customInput?: boolean;
}

/** Info available to output handlers after each turn */
export interface TurnInfo {
  turnCount: number;
  maxTurns: number;
  tokensUsed: number;
  maxContextTokens: number;
  planStepsTotal?: number;
  planStepsDone?: number;
  sessionId: string;
  compressCount: number;
  /** 缓存命中 tokens（仅 DeepSeek/OpenAI 等支持返回，其他厂商为 undefined） */
  cacheHitTokens?: number;
  /** 缓存未命中 tokens */
  cacheMissTokens?: number;
  /** 当前轮次缓存命中率 (0-100)，不支持的 provider 为 undefined */
  cacheHitRate?: number;
  /** 所有轮次的缓存记录（用于分析缓存稳定性） */
  cacheHistory?: CacheTurnRecord[];
  /**
   * 会话级缓存命中率**平均值**（按 token 量加权，0-100）。
   *
   * 与 `cacheHitRate`（仅最近一轮、噪声大）互补：判断"缓存到底省了多少"应看平均值。
   * 无轮次历史 / 厂商不返回缓存字段时为 undefined。
   */
  cacheHitRateAvg?: number;
  /** 本回合（一次 run）缓存命中率加权均值（0-100）—— 回合结束时给出 */
  cacheHitRateTurnAvg?: number;
  /** 已记录的缓存轮次数（逐轮事件用轻量计数，避免传整个 history） */
  cacheTurnsCount?: number;
  /**
   * 命中率**显示片段**（已格式化，如 `95.2% turn (12t)` / `n/a`）。
   *
   * 口径选择与格式化都在后端完成 —— UI 只做插值渲染，不再自行挑 turn/last/avg 或拼标签。
   */
  cacheDisplay?: string;
  /** 会话累计输入 token 总量（无 usage 字段的 provider 为 undefined） */
  totalInputTokens?: number;
  /** 会话累计输出 token 总量（无 usage 字段的 provider 为 undefined） */
  totalOutputTokens?: number;
}

// ── 半块 Unicode 字符画 ─────────────────────────────────────────────
// 终端字符宽高比约 1:2，用 ▀▄█ 每个字符承载 2 个垂直像素，ANSI 真彩色。
// 返回 { text, width } — width 是视觉列数，供外部对齐。
const RST = '\x1b[0m';
function ansi(r: number, g: number, b: number) { return `\x1b[38;2;${r};${g};${b}m`; }
function ansiBg(r: number, g: number, b: number) { return `\x1b[48;2;${r};${g};${b}m`; }

export async function imageToAscii(imagePath: string, maxWidth = 60): Promise<{ text: string; width: number } | null> {
  let sharp: any;
  try {
    sharp = (await import('sharp')).default;
  } catch { return null; }
  try {
    const image = sharp(imagePath);
    const metadata = await image.metadata();
    const imgWidth = metadata.width || 100;
    const imgHeight = metadata.height || 100;
    const targetWidth = Math.min(maxWidth, imgWidth);
    const targetHeight = Math.max(2, Math.floor(targetWidth * (imgHeight / imgWidth) / 2)) * 2;
    const { data, info } = await image
      .resize(targetWidth, targetHeight, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height;
    const lines: string[] = [];
    for (let y = 0; y < h; y += 2) {
      let line = '';
      for (let x = 0; x < w; x++) {
        const ti = (y * w + x) * 4;
        const bi = ((y + 1) * w + x) * 4;
        const tr = data[ti]!, tg = data[ti + 1]!, tb = data[ti + 2]!, ta = data[ti + 3]!;
        const br = data[bi]!, bg = data[bi + 1]!, bb = data[bi + 2]!, ba = data[bi + 3]!;
        const topOn = (tr + tg + tb) / 3 >= 128 && ta >= 64;
        const botOn = (br + bg + bb) / 3 >= 128 && ba >= 64;
        const idx = (topOn ? 2 : 0) | (botOn ? 1 : 0);
        if (idx === 0) line += ' ';
        else if (idx === 1) line += ansi(br, bg, bb) + '▄' + RST;
        else if (idx === 2) line += ansi(tr, tg, tb) + '▀' + RST;
        else line += ansi(tr, tg, tb) + ansiBg(br, bg, bb) + '▀' + RST;
      }
      lines.push(line);
    }
    return { text: lines.join('\n'), width: w };
  } catch {
    return null;
  }
}

// ─── AgentLoop ───────────────────────────────────────────────────────

/**
 * P1 M3 内置默认管道槽位（与 runtime/defaults.ts 的 kernel.pipeline 骨架一致）。
 * configCenter 注入时优先读配置；未注入（delegate-tool 等路径）时用此默认。
 * 已迁移到 src/orchestrator/create-kernel.ts（DEFAULT_PIPELINE_SLOTS）。
 * 此处保留 re-export 供外部引用。
 */
// re-export from create-kernel for backward compatibility


/**
 * AgentLoop 装配服务表（P6-2：拆两层 —— 服务 / 配置）。
 *
 * P6-2 判据「新增一个内核服务不再改 AgentLoop 签名」：服务一律进本表，
 * 构造签名固定为 `constructor(services: AgentLoopServices, opts?: AgentLoopConfigOptions)`。
 * 新增服务 = 本接口加键 + 装配方（factory / delegate-tool）提供，构造器不感知；
 * 阶段要消费它时再同步到 StageServiceMap（P6-3 整合）。
 *
 * 继承自旧 AgentLoopOptions（P1 遗留项 2a：位置参数 → 具名对象）的服务部分。
 */
export interface AgentLoopServices {
  provider: Provider;
  contextComposer: LayeredContextComposer;
  compressor: CompressorOrchestrator;
  orchestrator: LLMOrchestrator;
  toolExecutor: ToolExecutor;
  toolRegistry: ToolRegistry;
  conversationStore: ConversationStore;
  eventStore: EventStore;
  statsManager: StatsManager;
  summaryStore: SummaryStore;
  outputHandler?: OutputHandler | null;
  skillRegistry?: SkillRegistry;
  mcpBridge?: MCPBridge;
  dependencyAnalyzer?: DependencyAnalyzer;
  agentRegistry?: AgentRegistry;
  flowRegistry?: MachineRegistry;
  providerRouter?: ProviderRouter;
  configCenter?: RuntimeConfigCenter;
  modelRouter?: ModelRouter;
  turnRecorder?: TurnRecorder;
}

/**
 * AgentLoop 装配配置（字面量/策略集合 —— 不服务化，与服务表分离）。
 * loopHooks 属装配时序对象，一并放配置层。
 */
export interface AgentLoopConfigOptions {
  sessionDir: string;
  maxTurns?: number;
  maxContextTokens?: number;
  personaDir?: string;
  dangerousTools?: Set<string>;
  allowlistTools?: Set<string>;
  loopHooks?: LoopHookBus;
  /**
   * 循环级验证门信号（plan_execute 预测落空时置位，repair.verification 消费）。
   * 装配层创建并注入同一引用 —— 工具侧写、循环侧读。
   */
  planHandoff?: { pending: string | null };
  /**
   * 外部注入的插件宿主（统一宿主）：传入 PluginManager 的宿主，
   * 使 loop 挂载的内核插件与目录插件共享同一 PluginHost（deps/getService 互通）。
   * 缺省由 createKernel 内部创建。
   */
  pluginHost?: PluginHost<Record<string, unknown>, LoopHooks>;
}

/**
 * AgentLoop — 串联所有模块的完整 Agent 主循环
 *
 * 核心流程：compose -> LLM -> parse -> tool -> compose 的循环
 *
 * 通过 OutputHandler 接口解耦输出：
 * - 传 null → 无输出（静默模式）
 * - 传实现 → 输出到 TUI / CLI / 日志 等任意目标
 */
export class AgentLoop {
  // ── 构造注入依赖（P6-2：服务表 + 配置两层，签名不再逐字段列举） ──
  private provider: Provider;
  private contextComposer: LayeredContextComposer;
  private compressor: CompressorOrchestrator;
  private toolExecutor: ToolExecutor;
  private toolRegistry: ToolRegistry;
  private conversationStore: ConversationStore;
  private eventStore: EventStore;
  private statsManager: StatsManager;
  private sessionDir: string;
  private summaryStore: SummaryStore;
  private maxTurns: number;
  private maxContextTokens: number;
  private skillRegistry?: SkillRegistry;
  private mcpBridge?: MCPBridge;
  private dependencyAnalyzer?: DependencyAnalyzer;
  private personaDir?: string;
  private providerRouter?: ProviderRouter;
  private modelRouter?: ModelRouter;
  private turnRecorder?: TurnRecorder;
  /** 循环级验证门信号：plan_execute 预测落空时置位，迭代结束时按 repair.verification 消费 */
  private planHandoff: { pending: string | null };
  /** 验证证据账本（P1-B）：本轮产生的验证证据数与是否发生修改（turn-end 证据门消费） */
  private turnEvidenceCount = 0;
  private turnHadMutation = false;

  /**
   * 本轮失败描述（P2-2 恢复审查）：供旁路恢复监督者判断主Agent是否在正确应对失败。
   * 复用既有状态（plan_execute 预测落空 / 证据门条件），无新管道。
   */
  private describeTurnFailure(): string | undefined {
    if (this.planHandoff.pending) {
      return `plan_execute 预测落空：${this.planHandoff.pending}`;
    }
    if (this.turnHadMutation && this.turnEvidenceCount === 0) {
      return '本轮修改了文件但没有产生任何验证证据（测试/编译/lint），不能直接结束';
    }
    return undefined;
  }

  private abortController: AbortController | null = null;
  private interrupted = false;
  /** 串行化锁：确保 run() 不会并发执行 */
  private _runMutex: Promise<void> = Promise.resolve();
  private recentToolNames: string[] = [];
  private currentSummary: string | undefined;
  private orchestrator: LLMOrchestrator;
  private activePlan: Plan | undefined;
  private agentRegistry?: AgentRegistry;
  private outputHandler: OutputHandler | null;
  /** ask_user 工具的交互 handler（按 loop 实例注入：构造时取 outputHandler.onAskUser，
   *  多路 UI 并发时各 loop 各自应答，不再覆盖进程内唯一全局 handler） */
  private askUserHandler: ((questions: AskUserQuestion[]) => Promise<string>) | null = null;
  /** say 工具：本回合状态（'submitted' 已交付结论 / 'aborted' 连续失败超限） */
  private sayStatus: 'submitted' | 'aborted' | null = null;
  /** say 工具：连续校验失败次数（report 失败时 toolCalled 仍为 true，会重置
   *  idleTurnCount 使空转兜底失效，故需独立上限，防空转到 maxTurns） */
  private sayFailureCount = 0;
  /** say 待落盘的交付正文（延后到 tool_result 之后落盘，见 takeSayStatus 注释） */
  private sayPendingContent: string | null = null;
  private compressCount = 0;
  private needsAggressiveCompress = false;
  private cacheHitTokens = 0;
  private cacheMissTokens = 0;
  /** 会话累计输入 token 总量（llm 阶段逐轮累加，TUI 显示用） */
  private totalInputTokens = 0;
  /** 会话累计输出 token 总量（llm 阶段逐轮累加，TUI 显示用） */
  private totalOutputTokens = 0;
  private cacheTurns: CacheTurnRecord[] = [];
  /** 本回合（一次 run）的缓存记录起点索引 —— 用于在回合结束时算"本回合均值" */
  private turnCacheFrom = 0;
  private logCacheHits: boolean;
  private currentTurn = 0;
  /** 公开只读访问器 — 供 TurnRecorder / RollbackTool 等查询当前回合号 */
  get turnNumber(): number { return this.currentTurn; }
  private lastSavedSummary: string | undefined;
  private pendingImpactInfo: string | null = null;
  private requestId: string;
  private logger: ReturnType<typeof createLogger>;
  private flowRegistry: MachineRegistry;
  /** 旁路Agent 管理器（factory 注入） */
  bypassManager?: import('../bypass/manager.js').BypassManager;
  /** 本轮用户消息的旁路注入缓存（preTurn 首轮产出，后续迭代复用） */
  private _bypassInjections?: import('../bypass/types.js').Injection[];
  /**
   * 陪伴模式台词 TTS 钩子（factory 在 companion.tts.enabled 时装配）。
   * postTurn 后台调用，实现方自行排队与降级，绝不阻塞回合。
   */
  companionVoice?: {
    onTurnEnd(
      text: string,
      character: string,
      notify: (type: string, payload?: unknown) => void,
      overrides?: { voice?: string; voiceId?: string; tone?: string; sayId?: string },
    ): void;
  };

  /** 本轮通过 companion_say 的表达（turn-scoped；postTurn 时旁路用它维护世界） */
  companionExpressions: Array<{ text: string; as: 'speak' | 'think'; tone?: string }> = [];

  /** companion_say 工具执行时捕获表达 */
  recordCompanionExpression(e: { text: string; as: 'speak' | 'think'; tone?: string }): void {
    this.companionExpressions.push(e);
  }

  /** 工具层向 UI 推送协议事件（companion.say / companion.voice 等） */
  emitUiEvent(type: string, payload?: unknown): void {
    this.outputHandler?.onEvent?.(type, payload);
  }

  /** 当前轮识别出的意图（orchestrator preTurn 产出，供 compose 和 postTurn 消费） */
  private _currentIntent: string | null = null;
  private activeProvider?: Provider;
  private scheduler: HeartbeatScheduler | null = null;
  private schedulerInitialized = false;
  /** 定时任务触发后待注入对话的通知 */
  pendingTaskNotifications: Array<{ name: string; firedAt: string }> = [];
  /** 异步子Agent 完成后的结果队列（delegate-tool 写入，主循环消费） */
  pendingAsyncResults: Array<{ handle: string; agentName: string; status: 'completed' | 'failed'; result?: string; error?: string }> = [];
  /** 当前正在执行的定时任务名（供 TUI 显示上下文），run 前设置，run 后清除 */
  pendingTaskName: string | null = null;
  /** 知识库状态引用（factory 注入） */
  kbState: { lastQuery: string } | null = null;
  /** 图片索引存储（会话级） */
  readonly imageStore = new ImageStore();
  /** 待注入图片队列（view_image 工具填充，下次 compose 前消费） */
  readonly pendingImageInjections: Array<{ imgId: string; data: string; media_type: string }> = [];
  /** 原生视频/音频待注入（view_media 产出；context 阶段按 inputTypes 门控注入） */
  readonly pendingMediaInjections: Array<{ type: 'video' | 'audio'; media_type: string; data: string }> = [];
  /** 渠道预取图片（渠道层在 run() 前写入，_runInternal 一次性消费） */
  channelImages: Array<{ data: string; media_type: string }> | null = null;
  /** Fallback 通知（onFallback 回调写入，runTurn 一次性消费后清空） */
  pendingFallbackInfo: string | null = null;
  /** 降级链恢复主 Provider 通知（onRecover 回调写入，runTurn 一次性消费后清空） */
  pendingRecoverInfo: string | null = null;
  /** 当前激活的上下文路由器，初始化为 NormalRouter，首次 syncRouter() 时同步到全局状态 */
  activeRouter: IContextRouter = new NormalRouter();
  /** Whether any tools were executed inline during the current stream */
  private inlineToolExecuted = false;
  /** Stores results from inline tool execution, keyed by tool_use_id */
  private inlineToolResults: Map<string, { content: string; isError: boolean }> = new Map();
  /**
   * 待应用的会话切换目标（switch_session 登记，**轮次边界**才真正生效）。
   * 见 switchSession() 的说明：切换若在工具执行中途生效，本轮 tool_result 会落进
   * 目标会话，原会话留下孤儿 tool_use（严格厂商 400 → 切换"做一半" → agent 反复补做）。
   */
  private pendingSessionDir: string | null = null;
  /** Tools that require user confirmation before execution */
  private dangerousTools: Set<string>;
  /** Tools whitelisted by user (skip confirmation — session-level, from 'always' response) */
  private allowlistTools: Set<string>;
  /** AOR (Absence of Restriction): skip all future permission checks for this session */
  private unrestrictedTools = false;
  /** Allowed bash commands (glob pattern matched, from config) */
  private allowedCommands: Set<string> = new Set();
  private configCenter?: RuntimeConfigCenter;
  private contextDirty = false;
  private loopGuard: LoopGuard;
  private resultBuffer: ToolResultBuffer;
  private bundleRegistry?: ToolBundleRegistry;
  private gitManager: GitManager;
  private switchingProvider = false;
  private lastContextTokens = 0;
  /** 公开只读访问器 — 供 UI 协议层（state.get）读取当前上下文 token 占用 */
  get contextTokensUsed(): number { return this.lastContextTokens; }
  private pendingCompression: Promise<CompressionResult | null> | null = null;

  // ── 内核服务（闭包触手正规化：旧 5 个裸闭包收敛为两个具名服务） ──
  private readonly toolService: ToolService;
  private readonly clusterService: ClusterService;

  private lifecycleSupervisor: LifecycleSupervisor | null = null;
  private previousProviderWasLocal = false;
  /** 当前 AgentLoop 的 thinking 状态（per-session 隔离） */
  private thinkingEnabled: boolean = false;
  private thinkingEffort: string | number | undefined = undefined;

  /**
   * 主循环钩子总线（P1 M2）—— 10 个钩子点在 runTurn/_runInternal 上挂载，
   * 插件经 PluginHost 的 ctx.onHook/aroundHook 接入（可短路/包裹）。
   * 无订阅者时 emit 走快路径，零开销。
   */
  readonly loopHooks: LoopHookBus;

  /**
   * 插件宿主（P1 M7）—— 挂载面即主循环钩子总线（loopHooks）。
   * 插件经 ctx.onHook/aroundHook 观察/拦截 10 个主循环钩子点（如 beforeToolExecute 权限链）。
   * 与旧 PluginManager（plugins/index.js）并存：前者是内核原语只管生命周期与回滚，
   * 后者保留发现与装载职责（P2 改造为构建于 PluginHost 之上）。
   * 空宿主零开销：不挂插件不影响任何逻辑。
   */
  readonly pluginHost: PluginHost<Record<string, unknown>, LoopHooks>;

  /**
   * P1 M3 内核管道 —— 配置驱动、模块可替换的执行链。
   * 当前仅 input/finalize 槽位启用（真实执行），其余槽位 M4-M6 逐步点亮。
   * 槽位本身是接缝：插件可经 PluginHost 的 aroundHook 拦截/短路单个槽位。
   */
  private readonly pipeline: Pipeline<TurnState, Record<string, unknown>, StageServiceMap>;


  /** 阶段模块的内核服务表（conversationStore / turnRecorder / sessionDir …） */
  private readonly stageServices = new Map<StageServiceKey, unknown>();

  constructor(services: AgentLoopServices, opts: AgentLoopConfigOptions) {
    // 服务表（AgentLoopServices）：业务对象
    const {
      provider, contextComposer, compressor, orchestrator, toolExecutor, toolRegistry,
      conversationStore, eventStore, statsManager, summaryStore,
      outputHandler, skillRegistry, mcpBridge,
      dependencyAnalyzer, agentRegistry, flowRegistry, providerRouter,
      configCenter, modelRouter, turnRecorder,
    } = services;
    // 配置层（AgentLoopConfigOptions）：字面量/策略集合
    const { sessionDir, maxTurns, maxContextTokens, personaDir, dangerousTools, allowlistTools, loopHooks, pluginHost, planHandoff } = opts;
    // ── 依赖注入（显式赋值，替代旧位置参数属性） ──
    this.provider = provider;
    this.contextComposer = contextComposer;
    this.compressor = compressor;
    this.toolExecutor = toolExecutor;
    this.toolRegistry = toolRegistry;
    this.conversationStore = conversationStore;
    this.eventStore = eventStore;
    this.statsManager = statsManager;
    this.sessionDir = sessionDir;
    this.summaryStore = summaryStore;
    this.maxTurns = maxTurns ?? getDefaultConfig().session.maxTurns;
    this.skillRegistry = skillRegistry;
    this.mcpBridge = mcpBridge;
    this.dependencyAnalyzer = dependencyAnalyzer;
    this.personaDir = personaDir;
    this.providerRouter = providerRouter;
    this.modelRouter = modelRouter;
    this.turnRecorder = turnRecorder;
    this.planHandoff = planHandoff ?? { pending: null };

    this.loopHooks = loopHooks ?? createLoopHookBus();
    // ── P1 M7：插件宿主 + P1 收官：createKernel() 统一装配 ──
    const kernel: KernelComponents = createKernel({
      configCenter,
      loopHooks: this.loopHooks,
      pluginHost,
    });
    this.pluginHost = kernel.pluginHost;
    // ── 阶段服务表（供 makeStageCtx 注入到管道上下文） ──
    this.stageServices.set('conversationStore', conversationStore);
    this.stageServices.set('configCenter', configCenter);
    this.stageServices.set('compressor', compressor);
    this.stageServices.set('turnRecorder', turnRecorder);
    this.stageServices.set('sessionDir', sessionDir);
    this.pipeline = kernel.pipeline;
    this.orchestrator = orchestrator;
    this.outputHandler = outputHandler ?? null;
    // 回调所有权转移：显式 bind —— 摘取方法后工具侧是裸调用（handler(questions)），
    // 若实现类是普通方法且依赖 this（如 ProtocolOutputHandler.pending），this 会丢。
    this.askUserHandler = outputHandler?.onAskUser
      ? (outputHandler.onAskUser.bind(outputHandler) as (questions: AskUserQuestion[]) => Promise<string>)
      : null;
    this.agentRegistry = agentRegistry;
    // MachineRegistry 由 factory.ts 注入，不创建默认实例（空注册表无实际作用）
    this.flowRegistry = flowRegistry!;
    this.dangerousTools = dangerousTools ?? new Set(deriveDangerousTools(() => this.toolRegistry.getAll()));
    this.allowlistTools = allowlistTools ?? new Set();
    this.configCenter = configCenter;
    // 优先级：configCenter（配置为权威）→ opts.maxContextTokens（调用方显式传入）
    // → DEFAULT。修复：原实现忽略 opts.maxContextTokens 且 configCenter 未配时
    // 返回 undefined（无兜底）→ context 阶段阈值 NaN 永不触发压缩。
    this.maxContextTokens = configCenter
      ? (configCenter.get<number>('session.maxContext') ?? maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS)
      : (maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS);
    this.requestId = crypto.randomUUID();
    this.logger = createLogger('AgentLoop').child('request', { requestId: this.requestId });
    this.gitManager = new GitManager(process.cwd());

    const stormWindowSize = this.configCenter ? (this.configCenter.get('repair.storm.windowSize') as number) : undefined;
    const stormThreshold = this.configCenter ? (this.configCenter.get('repair.storm.threshold') as number) : undefined;
    const stormExempt = this.configCenter ? (this.configCenter.get('repair.storm.stormExemptTools') as string[]) : undefined;
    const textLoopEnabled = this.configCenter ? (this.configCenter.get('repair.textLoop.enabled') as boolean) : undefined;
    const textLoopSim = this.configCenter ? (this.configCenter.get('repair.textLoop.similarity') as number) : undefined;
    const textLoopThresh = this.configCenter ? (this.configCenter.get('repair.textLoop.threshold') as number) : undefined;

    this.loopGuard = new LoopGuard({
      tool: {
        enabled: true,
        windowSize: typeof stormWindowSize === 'number' && stormWindowSize > 0 ? stormWindowSize : 6,
        threshold: typeof stormThreshold === 'number' && stormThreshold > 0 ? stormThreshold : 3,
        exemptTools: Array.isArray(stormExempt) ? stormExempt : [],
      },
      text: {
        enabled: textLoopEnabled !== false,
        windowSize: 6,
        threshold: typeof textLoopThresh === 'number' && textLoopThresh > 0 ? textLoopThresh : 3,
        minLength: 30,
        similarity: typeof textLoopSim === 'number' && textLoopSim > 0 ? textLoopSim : 0.75,
      },
    });

    const bufferEnabled = this.configCenter ? (this.configCenter.get('tools.resultBuffer.enabled') as boolean) : undefined;
    const bufferThreshold = this.configCenter ? (this.configCenter.get('tools.resultBuffer.threshold') as number) : undefined;
    const bufferIncludePreview = this.configCenter ? (this.configCenter.get('tools.resultBuffer.includePreview') as boolean) : undefined;
    const bufferPreviewChars = this.configCenter ? (this.configCenter.get('tools.resultBuffer.previewChars') as number) : undefined;

    this.resultBuffer = new ToolResultBuffer({
      sessionDir: this.sessionDir,
      enabled: typeof bufferEnabled === 'boolean' ? bufferEnabled : true,
      threshold: typeof bufferThreshold === 'number' && bufferThreshold > 0 ? bufferThreshold : 16384,
      includePreview: typeof bufferIncludePreview === 'boolean' ? bufferIncludePreview : true,
      previewChars: typeof bufferPreviewChars === 'number' && bufferPreviewChars > 0 ? bufferPreviewChars : 500,
    });

    this.logCacheHits = this.configCenter
      ? (this.configCenter.get('logging.logCacheHits') as boolean) === true
      : false;

    // ── Restore persisted values from configCenter ──
    if (this.configCenter) {
      // Restore allowedTools (session-level allowlist)
      const persistedAllowedTools = this.configCenter.get('safety.allowedTools') as unknown as string[] | undefined;
      if (Array.isArray(persistedAllowedTools) && persistedAllowedTools.length > 0) {
        this.allowlistTools = new Set(persistedAllowedTools);
      }

      // Restore allowedCommands (bash glob patterns)
      const persistedAllowedCommands = this.configCenter.get('safety.allowedCommands') as unknown as string[] | undefined;
      if (Array.isArray(persistedAllowedCommands) && persistedAllowedCommands.length > 0) {
        this.allowedCommands = new Set(persistedAllowedCommands);
      }

      // Restore dangerousTools：配置显式名单为加性覆盖（在 sideEffect 推导集之上追加）
      const persistedDangerousTools = this.configCenter.get('safety.dangerousTools') as unknown as string[] | undefined;
      this.dangerousTools = new Set([
        ...deriveDangerousTools(() => this.toolRegistry.getAll()),
        ...(Array.isArray(persistedDangerousTools) ? persistedDangerousTools : []),
      ]);

      // 用户未显式关闭时才从模型目录自动开启思考
      const thinkingCfg = this.configCenter?.get('provider.enableThinking');
      if (thinkingCfg !== false) {
        const info = getModelInfo(this.provider.getProviderType(), this.provider.getModel());
        if (info?.reasoningEffort) {
          this.thinkingEnabled = true;
          this.provider.setThinking?.(true, info.reasoningEffort);
        }
      }
    }

    // ── Load persisted allowlist from session directory ──
    sessionAllowlist.load(this.sessionDir).then(data => {
      for (const tool of data.allowedTools) {
        this.allowlistTools.add(tool);
      }
      for (const cmd of data.allowedCommands) {
        this.allowedCommands.add(cmd);
      }
    }).catch(() => {});

    // ── RuntimeConfigCenter watch subscriptions ──
    if (this.configCenter) {
      // Subscribe to dangerous tools changes
      this.configCenter.watch('safety.dangerousTools', (event) => {
        const list = Array.isArray(event.newValue) ? (event.newValue as string[]) : [];
        this.dangerousTools = new Set([...deriveDangerousTools(() => this.toolRegistry.getAll()), ...list]);
      });

      // Subscribe to allowed commands (bash glob patterns)
      this.configCenter.watch('safety.allowedCommands', (event) => {
        this.allowedCommands = new Set(event.newValue as string[]);
      });

      // Subscribe to context changes (mark dirty for next compose)
      this.configCenter.watch('context.*', (_event) => {
        this.contextDirty = true;
      });

      // 思考模式由 providers.json 中模型的 reasoningEffort 控制，启动时自动应用
      // 运行时通过 /model thinking <on|off|high|max> 临时覆盖
    }

    // ── 注册 view_image / view_media 工具（依赖 ImageStore + 注入队列） ──
    this.toolRegistry.register(
      createViewImageTool(this.imageStore, this.pendingImageInjections),
    );
    this.toolRegistry.register(
      createViewMediaTool(this.imageStore, this.pendingImageInjections, this.pendingMediaInjections, {
        getInputTypes: () => this.getActiveProvider().getCapabilities?.()?.inputTypes,
        getVideoInlineMaxBytes: () => this.configCenter?.get('multimodal.videoInlineMaxBytes') as number | undefined,
        getVideoMaxFrames: () => this.configCenter?.get('multimodal.videoMaxFrames') as number | undefined,
        getAudioInlineMaxBytes: () => this.configCenter?.get('multimodal.audioInlineMaxBytes') as number | undefined,
      }),
    );

    // ── P1 M4：context 阶段服务注册（值型服务放构造末尾，确保字段赋值完成） ──
    this.stageServices.set('toolRegistry', this.toolRegistry);
    this.stageServices.set('contextComposer', this.contextComposer);
    this.stageServices.set('summaryStore', this.summaryStore);
    this.stageServices.set('statsManager', this.statsManager);
    this.stageServices.set('gitManager', this.gitManager);
    this.stageServices.set('outputHandler', this.outputHandler);
    this.stageServices.set('maxContextTokens', this.maxContextTokens);
    this.stageServices.set('personaDir', this.personaDir);
    this.stageServices.set('bundleRegistry', this.bundleRegistry);
    this.stageServices.set('kbState', this.kbState);
    this.stageServices.set('loopHooks', this.loopHooks);
    // 惰性闭包：activeRouter 是 getter（随 companion 模式切换）
    this.stageServices.set('getRouter', () => this.activeRouter);
    // ── P1 M5：llm/tools 阶段服务注册 ──
    this.stageServices.set('eventStore', this.eventStore);
    this.stageServices.set('orchestrator', orchestrator);
    // ── 闭包触手正规化：旧 5 个裸闭包（clusterTransform/deepCompressRestore/
    //    executeSingleInline/flushInline/executeTools）收敛为两个具名服务 ──
    this.toolService = createToolService(() => this.makeToolExecContext());
    this.clusterService = createClusterService(() => this.makeClusterDeps());
    this.stageServices.set('toolService', this.toolService);
    this.stageServices.set('clusterService', this.clusterService);
    // ── P1 M6：bypass 阶段服务注册（bypassManager 由 factory 构造后注入 → 惰性闭包） ──
    this.stageServices.set('bypassManager', () => this.bypassManager);
  }

  /**
   * 中断当前运行：设置 interrupted 标志，中止 Provider 请求，
   * 并通过 OutputHandler 通知上层
   */
  interrupt(): void {
    this.interrupted = true;
    this.abortController?.abort();
    this.outputHandler?.onInterrupt?.();
    this.outputHandler?.onStatus?.('Operation interrupted.', 'warn');
  }

  /** Get current turn/mode info for status display */
  getTurnInfo(turnCount: number, tokensUsed: number): TurnInfo {
    let planStepsTotal: number | undefined;
    let planStepsDone: number | undefined;
    if (this.activePlan) {
      planStepsTotal = this.activePlan.steps.length;
      planStepsDone = this.activePlan.steps.filter(
        s => s.status as string === 'completed',
      ).length;
    }
    const hasCache = this.cacheHitTokens > 0 || this.cacheMissTokens > 0;
    // 命中率两个口径并存：
    //   cacheHitRate    —— 最近一轮（噪声大，用于诊断"刚发生了什么"）
    //   cacheHitRateAvg —— 会话级 token 加权平均（UI 主显示，回答"缓存到底省了多少"）
    const latestTurn = this.cacheTurns.at(-1);
    return {
      turnCount,
      maxTurns: this.maxTurns,
      tokensUsed,
      maxContextTokens: this.maxContextTokens,
      planStepsTotal,
      planStepsDone,
      sessionId: path.basename(this.sessionDir),
      compressCount: this.compressCount,
      cacheHitTokens: hasCache ? this.cacheHitTokens : undefined,
      cacheMissTokens: hasCache ? this.cacheMissTokens : undefined,
      cacheHitRate: latestTurn ? Math.round(latestTurn.hitRate * 10) / 10 : undefined,
      cacheHitRateAvg: averageHitRate(this.cacheTurns),
      // 本回合（一次 run）加权均值 + 轮次数（轻量计数，供逐轮事件复用）
      cacheHitRateTurnAvg: averageHitRate(this.cacheTurns.slice(this.turnCacheFrom)),
      cacheTurnsCount: this.cacheTurns.length,
      // 显示片段：口径选择 + 格式化都在后端完成，UI 只插值（回合结束优先"本回合均值"）
      cacheDisplay: formatCacheDisplay({
        turnAvg: averageHitRate(this.cacheTurns.slice(this.turnCacheFrom)),
        last: latestTurn ? Math.round(latestTurn.hitRate * 10) / 10 : undefined,
        avg: averageHitRate(this.cacheTurns),
      }),
      cacheHistory: this.cacheTurns.length > 0 ? [...this.cacheTurns] : undefined,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
    };
  }

  private getRecentToolCallNames(): string[] {
    return this.recentToolNames;
  }

  /**
   * 就地切换到指定 session（**延迟生效**）。
   *
   * 只登记目标，真正切换发生在本轮所有落盘完毕后的轮次边界
   * （主循环 → applyPendingSessionSwitch）。
   *
   * 为什么不能立即切：本轮 tool_result 必须落在**发起调用的会话**里。若当场改
   * this.sessionDir，工具结果 flush 时用的是下一轮 ctx 的新目录 → 结果写进目标
   * 会话、原会话留下孤儿 tool_use → 严格厂商（DeepSeek/OpenAI）整请求 400 →
   * 该会话不可用，且 agent 会认为切换"没做成"而在后续轮次反复补做（2026-09-17
   * 实测：微信渠道因此被反复切走、与 TUI 串台）。
   */
  async switchSession(newSessionDir: string): Promise<void> {
    this.pendingSessionDir = newSessionDir;
  }

  /**
   * 应用待切换的会话（轮次边界调用）。此处才真正改 sessionDir 并重置会话态 ——
   * 此时本轮 tool_result 已全部落盘，不存在写错目录的风险。
   */
  private async applyPendingSessionSwitch(): Promise<void> {
    const next = this.pendingSessionDir;
    if (!next) return;
    this.pendingSessionDir = null;
    if (next === this.sessionDir) return;

    this.sessionDir = next;
    this.currentSummary = undefined;
    this.compressCount = 0;
    this.needsAggressiveCompress = false;
    this.inlineToolResults.clear();
    this.pendingImpactInfo = null;
    this.pendingTaskNotifications = [];
    this.pendingCompression = null;
    this.clusterService.setDeepCompressState({ original: null, restore: false });
    this.lastContextTokens = 0;
    // 重载摘要
    try {
      const persisted = await this.summaryStore.load(this.sessionDir);
      if (persisted) this.currentSummary = persisted;
    } catch {}
    // 重载权限白名单
    sessionAllowlist.load(this.sessionDir).then(data => {
      this.allowlistTools = new Set(data.allowedTools ?? []);
      this.allowedCommands = new Set(data.allowedCommands ?? []);
    }).catch(() => {});
  }

  /** 设置调度器 */
  setScheduler(scheduler: HeartbeatScheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * 组装单个 Zone 的预览文本（供设置页展示真实内容，如 zone1 锚点区）。
   * 复用真实 composer 实例与其已注册的 ContextSource（skills/agents/mcp/memory），
   * 保证预览与线上组装一致。Zone 不存在或未启用 → 返回 null。
   */
  async previewContextZone(
    zoneKey: string,
  ): Promise<{ zone: string; text: string; tokens: number } | null> {
    return this.contextComposer.previewZone(zoneKey, {
      sessionDir: this.sessionDir,
      cwd: process.cwd(),
      timestamp: formatTimestamp(),
      maxContextTokens: this.maxContextTokens,
      tools: [],
      history: [],
      userInput: '',
    });
  }

  /** 陪伴模式：从 JSONL 移除本轮工具调用完整回合（B2 拆出至 loop-session.ts） */
  private async removeLastRoundFromJsonl(): Promise<void> {
    return removeLastRoundFromJsonl(this.sessionDir);
  }

  /** 陪伴模式工具调用清理（B2 拆出至 loop-session.ts） */
  private async cleanCompanionJsonl(): Promise<void> {
    return cleanCompanionJsonl(this.sessionDir);
  }

  /** 陪伴模式定时任务：移除触发词与工具链，保留模型自然回复（B2 拆出至 loop-session.ts） */
  async removeTriggerFromJsonl(): Promise<void> {
    return removeTriggerFromJsonl(this.sessionDir);
  }


  /**
   * 本渠道标识（渠道级模式隔离的 key）。
   * 首次访问（必然发生在 session 被切换**之前**）时惰性确定并缓存 —— sessionDir 会随
   * 陪伴切换改变，必须在切换前锁定，否则渠道会漂移（例如切到陪伴目录后推导不出前缀）。
   */
  private _channelKey: string | null = null;
  get channelKey(): string {
    if (!this._channelKey) this._channelKey = channelKeyOf(this.sessionDir);
    return this._channelKey;
  }

  /**
   * 同步**本渠道**的 Router 到当前 loop。
   * 每轮 runTurn 开头调用。模式按渠道隔离：只跟随本渠道（this.channelKey）的 Router，
   * 某个渠道进入/退出陪伴不会波及其它渠道的 session 与模式。
   */
  async syncRouter(): Promise<void> {
    const targetRouter = getRouterForChannel(this.channelKey);
    if (this.activeRouter?.name === targetRouter.name) return;

    // 切出旧 Router
    if (this.activeRouter) {
      await this.activeRouter.onDeactivate?.(this);
    }

    // 切入新 Router
    this.activeRouter = targetRouter;
    await this.activeRouter.onActivate?.(this);
  }

  /** 获取调度器 */
  getScheduler(): HeartbeatScheduler | null {
    return this.scheduler;
  }

  /** 添加定时任务 */
  async addScheduledTask(name: string, scheduleType: 'daily', time: string): Promise<void> {
    if (!this.scheduler) return;
    await this.scheduler.addTask(
      name,
      scheduleType,
      { time },
      { type: 'scheduled', target: name, payload: {} },
      [],
    );
  }

  /** 注入 LifecycleSupervisor，用于运行时切换 provider 时自动管理本地模型进程 */
  setLifecycleSupervisor(supervisor: LifecycleSupervisor): void {
    this.lifecycleSupervisor = supervisor;
  }

  /** 注入工具包注册表（在 factory.ts 中紧接 AgentLoop 创建后调用）。
   *  必须同步 stageServices —— 否则 context 阶段 ctx.get('bundleRegistry')
   *  拿到构造时捕获的 undefined，工具包过滤整体失效（全量工具暴露）。 */
  setBundleRegistry(registry: ToolBundleRegistry): void {
    this.bundleRegistry = registry;
    this.stageServices.set('bundleRegistry', registry);
  }

  /** 运行时替换 outputHandler（用于 server 模式按请求切换流式输出）；askUserHandler 同步跟随。
   *  同步 stageServices —— 否则 context 阶段 ctx.get('outputHandler') 仍指向构造时旧 handler，
   *  压缩/状态提示会发给错误的输出目标（与 setBundleRegistry 同类问题）。 */
  setOutputHandler(handler: OutputHandler): void {
    this.outputHandler = handler;
    // 同构造路径：显式 bind，保证摘取后的 handler 裸调用不丢 this（见构造处注释）
    this.askUserHandler = handler.onAskUser
      ? (handler.onAskUser.bind(handler) as (questions: AskUserQuestion[]) => Promise<string>)
      : null;
    this.stageServices.set('outputHandler', handler);
  }

  /** 当前 loop 的用户交互 handler（ask_user 工具注入点：按实例而非全局单例） */
  getAskUserHandler(): ((questions: AskUserQuestion[]) => Promise<string>) | null {
    return this.askUserHandler;
  }

  /**
   * say 工具提交入口：校验 → 暂存交付正文 → 置回合结束标志。
   * 落盘与屏显**不在这里**做（2026-09-18 实测修正）：此刻 tool_result 尚未写入
   * （loop-tools 在工具返回后才追加），若现在 append assistant 文本，历史尾部会
   * 停在 user(tool_result)，用户下一条消息即构成"连续 user"、被严格厂商整请求拒绝。
   * 故正文暂存到 sayPendingContent，由 takeSayStatus() 在 tool_result 之后统一落盘 + 屏显。
   *
   * 为什么最终仍要落成 assistant 消息（而非只留工具形态）：
   *   - 压缩 Phase 4 的规则裁剪（trimToolResults / dedup / truncateLargeToolCalls）
   *     只作用于 tool 消息，assistant 文本不受影响
   *   - 摘要输入里自然语言比 [ToolUse] JSON 形态更不易被略写
   *   - 历史尾部以 assistant 文本收尾（延后落盘后成立），避免"连续 user 消息"
   * 返回 ok=false 时由工具层抛错 → is_error → loop 自动续轮让模型重写。
   */
  async submitSay(content: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const text = (content ?? '').trim();
    if (!text) {
      this.sayFailureCount++;
      // 连续 3 次空内容即中止：say 失败时 toolCalled 仍为 true 会重置
      // idleTurnCount，空转兜底失效，只能靠 maxTurns —— 故此处独立设限。
      if (this.sayFailureCount >= 3) {
        this.sayStatus = 'aborted';
        return {
          ok: false,
          error: `say 连续 ${this.sayFailureCount} 次内容为空。本回合已结束，请在下一条消息里重新汇报。`,
        };
      }
      return {
        ok: false,
        error: 'say 的 content 不能为空：请把要交付用户的结论正文写进 content 后重新调用。',
      };
    }

    // 暂存正文：落盘与屏显延后到 takeSayStatus()（tool_result 落盘之后）
    this.sayPendingContent = text;
    this.sayStatus = 'submitted';
    return { ok: true };
  }

  /**
   * 消费 say 状态（预填进 TurnState；消费即重置，供每回合独立判定）。
   *
   * 顺序要点：本方法在工具执行（含 tool_result 落盘）之后、finalize 之前被调用，
   * 因此交付正文的落盘与屏显放在这里 —— 历史才会以 assistant 文本收尾，
   * 而不是停在 user(tool_result)（否则用户下一条消息构成"连续 user"）。
   */
  private async takeSayStatus(): Promise<'submitted' | 'aborted' | undefined> {
    const status = this.sayStatus;
    const pending = this.sayPendingContent;
    this.sayStatus = null;
    this.sayPendingContent = null;
    this.sayFailureCount = 0;

    if (status === 'submitted' && pending) {
      try {
        await this.conversationStore.append(this.sessionDir, {
          role: 'assistant',
          content: [{ type: 'text', text: pending }],
        });
      } catch (err) {
        // 落盘失败不阻断交付（屏显仍应发生），但记下便于排查
        this.logger?.warn?.('takeSayStatus: append assistant message failed', {
          error: (err as Error).message,
        });
      }
      // 走专用通道（onSay）：UI 可据此把"交付"与普通输出分开渲染；
      // 未实现 onSay 的渠道回退 onText，保持兼容。
      if (this.outputHandler?.onSay) this.outputHandler.onSay(pending);
      else this.outputHandler?.onText?.(pending);
    }

    return status ?? undefined;
  }

  /** 获取当前 active Provider（考虑 Router 路由） */
  getActiveProvider(): Provider {
    return this.activeProvider ?? this.provider;
  }

  /** 运行时切换 KVCache 隔离 ID（模式切换用：普通↔陪伴） */
  setActiveUserId(userId: string): void {
    const provider = this.activeProvider ?? this.provider;
    provider.setUserId?.(userId);
  }

  /** 获取当前意图簇 capability（用于簇摘要读取与历史过滤）。无意图时返回 'general'。 */
  getCurrentIntentCapability(): string {
    if (!this._currentIntent) return 'general';
    return this._currentIntent.match(/^\[(\w+)\]/)?.[1] ?? 'general';
  }

  // ── Provider 路由族（B4 拆出至 loop-provider.ts）──────────────────

  /** 构造 Provider 路由族依赖快照（可变状态经访问器现取当前值） */
  private makeProviderDeps() {
    return {
      providerRouter: this.providerRouter,
      modelRouter: this.modelRouter,
      lifecycleSupervisor: this.lifecycleSupervisor,
      configCenter: this.configCenter,
      outputHandler: this.outputHandler,
      getProvider: () => this.provider,
      getActiveProvider: () => this.getActiveProvider(),
      getLastContextTokens: () => this.lastContextTokens,
      getCurrentMaxContextTokens: () => this.maxContextTokens,
      getSessionDir: () => this.sessionDir,
    };
  }

  /** 切换 Provider 路由模式（B4 拆出至 loop-provider.ts） */
  toggleProvider(): void {
    const r = toggleProvider(this.makeProviderDeps());
    if (r?.previousProviderWasLocal !== undefined) {
      this.previousProviderWasLocal = r.previousProviderWasLocal;
    }
  }

  /** 注册新 Provider（用于 switch_provider 工具带 api_key 动态注册） */
  registerProvider(name: string, provider: Provider): void {
    this.providerRouter?.register(name, provider);
  }

  /** 切换到指定名称的 Provider（B4 拆出至 loop-provider.ts；并发经 switchQueue 串行化） */
  async switchProvider(providerName: string, model?: string): Promise<void> {
    // 串行队列：config watch 副作用（provider.*.model 变更自动切换）与显式
    // model.switch 并发到达时，旧守卫 `if (this.switchingProvider) return` 会
    // 静默丢弃后到者——UI 收到 ok 但切换丢失，状态栏停留旧模型。排队后两次
    // 切换串行执行，第二次命中同 model 时幂等（不重建，仅 setDefault + 回写）。
    const run = this.switchQueue.then(() => this.doSwitchProvider(providerName, model));
    this.switchQueue = run.catch(() => { /* 单次失败不阻断后续排队切换 */ });
    await run;
  }

  /** 切换串行队列：并发切换不再被静默丢弃（见 switchProvider） */
  private switchQueue: Promise<void> = Promise.resolve();

  private async doSwitchProvider(providerName: string, model?: string): Promise<void> {
    this.switchingProvider = true;
    try {
      const r = await switchProvider(this.makeProviderDeps(), providerName, model);
      // 回写可变状态
      this.provider = r.provider;
      this.activeProvider = undefined;
      this.orchestrator?.setProvider(r.provider);
      this.providerRouter?.setDefault(providerName);
      if (r.previousProviderWasLocal !== undefined) {
        this.previousProviderWasLocal = r.previousProviderWasLocal;
      }
      if (r.maxContextTokens !== undefined) {
        this.maxContextTokens = r.maxContextTokens;
      }
      if (r.needsCompression !== undefined) {
        this.clusterService.setNeedsCompression(r.needsCompression);
      }
      // 切换消息必须在状态回写完成后发出：UI 收到消息会立即经 state.get 刷新
      // 状态栏（getActiveProvider 读 this.activeProvider ?? this.provider），
      // 若回写前发出，刷新会读到旧 provider（竞态：状态栏停留在旧模型）。
      this.outputHandler?.onStatus?.(
        `Provider switched to ${providerName} (${r.provider.getProviderType()}/${r.provider.getModel()})`,
        'info',
      );
    } finally {
      this.switchingProvider = false;
    }
  }

  /** 从 RuntimeConfigCenter 中的配置 + 环境变量动态创建 Provider（B4 拆出） */
  private tryCreateProviderFromConfig(providerName: string): Provider | undefined {
    return tryCreateProviderFromConfig(this.makeProviderDeps(), providerName);
  }

  /** 订阅 RuntimeConfigCenter 变更，让 update_config 即时生效（B4 拆出） */
  subscribeConfig(): void {
    subscribeConfig(this.makeProviderDeps(), {
      switchProvider: (name, model) => this.switchProvider(name, model),
      setMaxTurns: (n) => { this.maxTurns = n; },
      setMaxContextTokens: (n) => { this.maxContextTokens = n; },
    });
  }

  /** 切换回自动路由模式（B4 拆出至 loop-provider.ts） */
  switchToAutoRoute(): void {
    switchToAutoRoute(this.makeProviderDeps());
  }

  /** 获取 Provider 路由信息（B4 拆出至 loop-provider.ts） */
  getProviderRoutingInfo(): { providerLabel: string; isLocal: boolean; mode: string } | null {
    return getProviderRoutingInfo(this.makeProviderDeps());
  }

  /** 运行时切换模型来源（B4 拆出至 loop-provider.ts） */
  setModelSource(role: ModelRole, source: 'main' | 'local'): void {
    setModelSource(this.makeProviderDeps(), role, source);
  }

  /** 读取模型来源配置（B4 拆出至 loop-provider.ts） */
  getModelSources(): Record<ModelRole, 'main' | 'local'> | null {
    return getModelSources(this.makeProviderDeps());
  }


  /** 定时任务触发时唤醒 Agent，自动发起一轮对话 */
  async notifyTaskFired(taskName: string): Promise<void> {
    this.pendingTaskNotifications.push({ name: taskName, firedAt: new Date().toISOString() });
    this.pendingTaskName = taskName;
    // Router 提供模式对应的提示词风格（陪伴→自然，正常→系统提示）
    await this.syncRouter();
    const prompt = this.activeRouter.getTaskPrompt(taskName);
    await this.run(prompt);
    this.pendingTaskName = null;
  }

  /**
   * 运行一轮对话（从用户输入到 Agent 停止或调用工具后继续）
   */
  async run(userInput: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._runMutex = this._runMutex.then(async () => {
        // 记录本回合缓存记录起点（回合结束时据此算"本回合加权均值"）
        this.turnCacheFrom = this.cacheTurns.length;
        try {
          await this._runInternal(userInput);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * 惰性会话物化（幂等）：boot() 新建分支只生成 session id 不落盘，
   * 用户首次输入到这里才补写 meta.json / session_start / stats。
   * meta.json 已存在（恢复旧 session / 已物化）则跳过。
   */
  private async materializeSessionIfNeeded(): Promise<void> {
    try {
      const pathMod = await import('node:path');
      const sid = pathMod.basename(this.sessionDir);
      // 渠道从 session id 前缀推断（注册表：内置 tui_/webui_/ui_/feishu_/clawbot_ + 插件扩展）
      const { resolveChannelFromSessionId } = await import('../session-channel.js');
      const channel = resolveChannelFromSessionId(sid);
      const { materializeLazySession } = await import('../memory/session.js');
      await materializeLazySession(this.sessionDir, {
        id: sid,
        projectKey: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        type: 'normal',
        channel,
      });
    } catch (err) {
      this.logger.warn('session materialize failed', { error: (err as Error).message });
    }
  }

  /**
   * run() 的内部实现，由串行化锁保护
   */
  private async _runInternal(userInput: string): Promise<void> {
    // ── 惰性会话物化（首条消息）：补齐 meta.json / session_start / stats ──
    // boot() 新建分支只生成 session id 不落盘；用户首次输入到这里才物化。
    // conversation.jsonl 由下方 append 自动创建；幂等（meta 已存在则跳过）。
    await this.materializeSessionIfNeeded();

    this.interrupted = false;
    this.abortController = new AbortController();
    // 每次用户输入重置防重复检测窗口与本轮表达缓冲
    this.loopGuard.reset();
    this.companionExpressions = [];
    // 钩子事件用的回合计数（在 try 外声明，catch 里 onTurnError 也能读到）
    let turnCount = 0;

    // 启动调度器
    if (this.scheduler && !this.schedulerInitialized) {
      await this.scheduler.start();
      this.schedulerInitialized = true;
    }

    // 注入待处理的定时任务通知
    if (this.pendingTaskNotifications.length > 0) {
      const notes = this.pendingTaskNotifications.splice(0);
      for (const note of notes) {
        const msg = `[Scheduled Task] "${note.name}" triggered at ${note.firedAt}.`;
        this.outputHandler?.onStatus?.(msg, 'info');
      }
    }

    // 注册 Ctrl+C 中断处理
    const onSigInt = () => {
      this.interrupted = true;
      this.abortController?.abort();
      this.outputHandler?.onStatus?.(
        'Interrupted. Press Ctrl+C again to exit.',
        'warn',
      );
    };
    process.once('SIGINT', onSigInt);

    try {
      // Load persisted summary from disk (always reload to pick up
      // updates from other loop instances sharing the same session dir)
      try {
        const persisted = await this.summaryStore.load(this.sessionDir);
        if (persisted) {
          this.currentSummary = persisted;
        }
      } catch {}

      // 0. 确保 Router 已同步——写用户消息前切换 session，避免跨 session 碎片
      await this.syncRouter();

      // 0.5 输入预处理：陪伴模式下剥离 [[旁白]] 并交给旁路（正常模式无此钩子，原样返回）
      if (this.activeRouter.transformUserInput) {
        try {
          userInput = await this.activeRouter.transformUserInput(userInput, this);
        } catch { /* 旁白处理失败则按原输入继续 */ }
      }

      // 1. 将用户输入追加到 conversation（多模态：图片/视频/音频路径检测 + 渠道预取图片）
      const activeP = this.getActiveProvider();
      const hasVision = activeP.getCapabilities?.()?.vision ?? false;
      const inputTypes = activeP.getCapabilities?.()?.inputTypes;
      const hasMediaCap = hasVision
        || (inputTypes?.includes('video') ?? false)
        || (inputTypes?.includes('audio') ?? false);
      let userContent: MessageContent | MessageContent[];
      if (hasVision && this.channelImages && this.channelImages.length > 0) {
        // 渠道预取图片（飞书/HTTP 等已下载为 base64）
        userContent = buildUserContentWithInlineImages(userInput, this.channelImages, this.imageStore);
        this.channelImages = null; // 一次性消费
      } else if (hasMediaCap) {
        // 多模态统一管线：图片/视频/音频路径检测 → 原生或抽帧降级
        userContent = await buildUserContentWithMedia(userInput, {
          imageStore: this.imageStore,
          supportsVideo: inputTypes?.includes('video') ?? false,
          supportsAudio: inputTypes?.includes('audio') ?? false,
          videoInlineMaxBytes: this.configCenter?.get('multimodal.videoInlineMaxBytes') as number | undefined,
          videoMaxFrames: this.configCenter?.get('multimodal.videoMaxFrames') as number | undefined,
          audioInlineMaxBytes: this.configCenter?.get('multimodal.audioInlineMaxBytes') as number | undefined,
        });
      } else {
        userContent = { type: 'text' as const, text: userInput };
      }
      const userMessage: Message = {
        role: 'user',
        content: userContent,
      };
      // 纯旁白轮：旁路产出仅作瞬态触发，不落盘（不污染档案、不被误当用户消息）
      if (!this.activeRouter.ephemeralInput) {
        await this.conversationStore.append(this.sessionDir, userMessage);
      }

      // 记录用户输入事件（瞬态旁白触发不记录，避免与真实用户输入混淆）
      if (!this.activeRouter.ephemeralInput) {
        await this.eventStore.append(this.sessionDir, {
          type: 'user_input',
          content: userInput,
          timestamp: formatTimestamp(),
        });
      }

      // 2. 主循环：compose -> LLM -> parse -> tool -> compose
      // 总轮次上限由 session.maxTurns 控制（UI 显示为硬上限，这里兑现该语义；
      // 超长任务可经配置调高 maxTurns）。
      // LoopGuard 跟踪连续触发次数，超过上限后强制停止以防止死循环。
      let toolWasCalled = false;
      let lastResult: { stop: boolean; stopReason?: string } = { stop: false };
      // 连续空转计数（方案 B：无工具调用且不停止的轮次；flow 强制继续但模型
      // 不再推进时，避免无限空转 —— 由 LoopGuard/空转兜底双保险）
      let idleTurnCount = 0;
      const IDLE_TURN_LIMIT = 3;
      while (true) {
        if (this.interrupted) {
          this.outputHandler?.onStatus?.('Agent stopped by user.', 'info');
          break;
        }

        // ── 应用待切换的会话（switch_session 登记，延迟到轮次边界）──
        // 上一轮的 tool_result 已全部落盘，此处切换不会写错目录。
        await this.applyPendingSessionSwitch();

        const result = await this.runTurn();
        turnCount++;
        lastResult = result;
        if (result.toolCalled) {
          toolWasCalled = true;
          idleTurnCount = 0; // 有工具调用 = 在推进，重置空转计数
        } else {
          idleTurnCount++; // 无工具调用：可能正常结束（stop）或 flow 强制继续
        }
        // ── 钩子：迭代结束（异步子Agent注入 / stats / loopGuard 可在此挂载） ──
        await this.loopHooks.emit('onIterationEnd', {
          turn: turnCount,
          stop: result.stop,
          stopReason: result.stopReason,
        });

        // ── 迭代级上下文占用推送（UI 即时刷新进度条，无需等整轮结束） ──
        // 与回合级 MESSAGE_TURN_INFO 语义区分：本事件不表示回合结束。
        // 必带会话累计 token 总量：本事件比 turn_info 频繁（每轮迭代都发），
        // 若不带这两个字段，UI 侧后发的刷新会把刚渲染的总量覆盖掉（表现"时有时无"）。
        this.emitUiEvent(UI_EVENT.MESSAGE_CONTEXT_UPDATE, {
          turnCount: this.turnNumber,
          tokensUsed: this.lastContextTokens,
          totalInputTokens: this.totalInputTokens,
          totalOutputTokens: this.totalOutputTokens,
          // 命中率与上下文量**同频**逐轮刷新（看即时效果）。"本回合均值"只在回合结束时给，
          // 故此处不传 turnAvg（回合尚未成立）；显示片段同样由后端格式化。
          cacheHitRate: this.cacheTurns.at(-1)
            ? Math.round(this.cacheTurns.at(-1)!.hitRate * 10) / 10
            : undefined,
          cacheHitRateAvg: averageHitRate(this.cacheTurns),
          cacheTurnsCount: this.cacheTurns.length,
          cacheDisplay: formatCacheDisplay({
            last: this.cacheTurns.at(-1)
              ? Math.round(this.cacheTurns.at(-1)!.hitRate * 10) / 10
              : undefined,
            avg: averageHitRate(this.cacheTurns),
          }),
        });

        // ── 异步子Agent 结果回合内注入 ─────────────────────────
        // delegate-tool 中异步任务完成后会将结果推送到此队列。
        // 本轮迭代结束后检查：有已完成的结果→注入对话→强制继续迭代，
        // 让 LLM 在当前 turn 内拿到结果并做出反应，无需跨 turn 手动查。
        // report 已交付/中止时不注入（队列保留到下回合，避免"已汇报却又续轮"）
        if (
          this.pendingAsyncResults.length > 0
          && result.stopReason !== 'say_submitted'
          && result.stopReason !== 'say_failed'
        ) {
          const results = this.pendingAsyncResults.splice(0);
          for (const r of results) {
            const content = r.status === 'completed'
              ? `[异步子Agent ${r.handle} (${r.agentName}) 已完成]\n${r.result ?? ''}`
              : `[异步子Agent ${r.handle} (${r.agentName}) 执行失败]\n${r.error ?? ''}`;
            await this.conversationStore.append(this.sessionDir, {
              role: 'user',
              content: [{ type: 'text', text: content }],
            });
          }
          result.stop = false; // 强制继续迭代，让 LLM 看到注入的异步结果
        }

        // 更新 stats
        await this.statsManager.increment(this.sessionDir, 'turn_count', 1);

        // ── 旁路Agent 迭代审查（每次 LLM 回复后） ──────────
        if (this.bypassManager) {
          try {
            const fullHistory: Message[] = await this.conversationStore.readAll(this.sessionDir);
            let iterAssistant = '';
            let iterUser = userInput;
            for (let i = fullHistory.length - 1; i >= 0; i--) {
              const m = fullHistory[i];
              const text = extractTextContent(m.content as any);
              if (m.role === 'assistant' && !iterAssistant && text) iterAssistant = text;
              if (m.role === 'user' && text) { iterUser = text; break; }
            }
            const iterCtx: import('../bypass/types.js').PostTurnContext = {
              userInput: iterUser,
              assistantOutput: iterAssistant,
              history: [],
              toolCallsThisTurn: this.recentToolNames ?? [],
              isLastIteration: false, // 仍在 loop 中
              failure: this.describeTurnFailure(),
            };
            this.bypassManager.postTurn(iterCtx).catch(() => {});
          } catch { /* ignore */ }
        }

        if (result.stop) {
          break;
        }

        // 方案 B：连续多轮无工具调用且未停止（flow 强制继续但模型不再推进）
        // → 空转兜底：强制退出，防止"无工具调用却停不下来"的死循环
        if (!result.toolCalled && idleTurnCount >= IDLE_TURN_LIMIT) {
          this.outputHandler?.onStatus?.(
            `No tool calls for ${IDLE_TURN_LIMIT} consecutive turns. Stopping to prevent idle loop.`,
            'warn',
          );
          lastResult = { stop: true, stopReason: 'idle_loop' };
          break;
        }

        // 总轮次上限（session.maxTurns）：兑现 UI/配置声明的硬上限语义
        if (turnCount >= this.maxTurns) {
          this.outputHandler?.onStatus?.(
            `Reached max turns (${this.maxTurns}). Stopping to honor the configured limit.`,
            'warn',
          );
          break;
        }

        // LoopGuard 升级检查：连续触发超过上限 → 强制停止
        if (this.loopGuard.escalated) {
          this.outputHandler?.onStatus?.(
            'LoopGuard: repeated suppression detected. Stopping to prevent infinite loop.',
            'warn',
          );
          break;
        }
      }

      // ── Post-turn cleanup（由 Router 控制）────────────────────
      // ── 钩子：回合结束（最终 postTurn / 簇消费 / 图片回收可在此挂载） ──
      await this.loopHooks.emit('onTurnEnd', {
        turn: turnCount,
        tokensUsed: this.lastContextTokens,
        stopReason: lastResult.stopReason,
      });
      if (this.activeRouter.onPostTurn) {
        await this.activeRouter.onPostTurn(this, this.pendingTaskName, toolWasCalled);
      }

      // ── 旁路Agent postTurn：后台观察，不阻塞 ────────────────
      if (this.bypassManager) {
        // 从 jsonl 读取本轮对话（与原来 CompanionRouter.onPostTurn 一致）
        let postUserInput = userInput;
        let postAssistantOutput = '';
        try {
          const fullHistory: Message[] = await this.conversationStore.readAll(this.sessionDir);
          // 取最后一条用户消息和助手消息
          for (let i = fullHistory.length - 1; i >= 0; i--) {
            const m = fullHistory[i];
            const text = extractTextContent(m.content as any);
            if (m.role === 'assistant' && !postAssistantOutput && text) {
              postAssistantOutput = text;
            }
            if (m.role === 'user' && text) {
              postUserInput = text;
              break; // 只取最后一轮的用户消息
            }
          }
        } catch { /* ignore */ }

        const fullLineCount = await this.conversationStore.countFull(this.sessionDir).catch(() => 0);

        const postCtx: import('../bypass/types.js').PostTurnContext = {
          userInput: postUserInput,
          assistantOutput: postAssistantOutput,
          history: [],
          toolCallsThisTurn: this.recentToolNames ?? [],
          isLastIteration: true,
          sessionId: path.basename(this.sessionDir),
          fullArchiveLineCount: fullLineCount,
          failure: this.describeTurnFailure(),
        };
        this.outputHandler?.onStatus?.('bypass-start', 'info');
        await this.bypassManager.postTurn(postCtx);
        this.outputHandler?.onStatus?.('bypass-end', 'info');
        // ── 陪伴表达契约：companion_say 说出的话才是"表达"；
        // 普通 text 是内心独白，不驱动世界、不再自动 TTS ──
        if (this.companionExpressions.length > 0) {
          const spoken = this.companionExpressions.filter((e) => e.as === 'speak');
          postAssistantOutput = spoken.map((e) => e.text).join('\n');
        }
        // ── 表达兜底：模型未按契约调用 companion_say 时（部分模型对
        // 工具化表达依从性弱，尤其在历史全是纯文本角色扮演时），
        // 把它的普通文本当作台词呈现，保证陪伴 UI 不会沉默。
        // 合规模型（已调用工具且含 speak 表达）不受影响。 ──
        if (
          this.activeRouter?.name === 'companion' &&
          postAssistantOutput &&
          !this.companionExpressions.some((e) => e.as === 'speak')
        ) {
          // 兜底与工具路径一致：带 sayId（前端时序守卫依赖），事件名走协议层常量
          const sayId = nextSayId();
          this.emitUiEvent(UI_EVENT.COMPANION_SAY, {
            mode: 'speak',
            text: postAssistantOutput,
            tone: '',
            at: new Date().toISOString(),
            sayId,
          } satisfies CompanionSayEvent);
          // 兜底路径同样落盘台词历史（companion.sayHistory 数据源；与工具路径共用 sayId）
          getSayHistoryStore().append({
            sayId,
            character: (this.activeRouter as { activeCompanionName?: string }).activeCompanionName || '',
            mode: 'speak',
            text: postAssistantOutput,
            at: new Date().toISOString(),
          });
          this.companionVoice?.onTurnEnd(
            postAssistantOutput,
            (this.activeRouter as { activeCompanionName?: string }).activeCompanionName || '',
            (type, payload) => this.outputHandler?.onEvent?.(type, payload),
            // overrides（第 4 参）：sayId 贯穿事件，供前端时序守卫；
            // cfg 由 factory 装配的包装层每回合现读，无需在此传入
            { sayId },
          );
        }
        // 清除本轮的旁路注入缓存和意图，下一轮用户消息重新 preTurn
        this._bypassInjections = undefined;
        this._currentIntent = null;

        // 消费 orchestrator 的簇归类结果
        const orch = this.bypassManager.getAgent('orchestrator');
        if (orch && 'lastClusterAssign' in orch) {
          const ca = (orch as any).lastClusterAssign;
          if (ca) {
            // 跨 session 污染防护：仅消费当前 session 的归类
            const currentSessionId = path.basename(this.sessionDir);
            if (ca.session_id && ca.session_id !== currentSessionId) {
              (orch as any).lastClusterAssign = null;
            } else {
              await this.eventStore.append(this.sessionDir, {
                type: 'cluster_assign',
                cluster_id: ca.cluster_id,
                capability: ca.capability,
                summary: ca.summary,
                line_start: ca.line_start,
                line_end: ca.line_end,
                timestamp: new Date().toISOString(),
              });
              (orch as any).lastClusterAssign = null;

              // ── 簇标记回填：给全量归档中该簇行号范围的消息打上 _cluster_id ──
              await this.conversationStore.markCluster(
                this.sessionDir,
                ca.line_start,
                ca.line_end,
                ca.cluster_id,
              );

              // ── 分簇压缩：检查该簇是否超限 ──
              await this.maybeCompressCluster(ca.cluster_id, ca.line_start, ca.line_end, ca.capability);
            }
          }
        }

        // ── 历史回填（方案 A）：orchestrator 开启晚时，对开启前未分类历史补做归类 ──
        // 预判：已回填到 fullLineCount（即无新增历史）时跳过，避免每轮全量读文件。
        // ⚠️ 必须校验 orchestrator 已激活：getAgent 只看注册表（orchestrator 默认无条件注册），
        //    未激活时若执行 backfill 会触发阻塞 LLM 调用，拖住 loop.run 的 resolve，
        //    导致消息完成后队列续上延迟数秒。
        if (orch && this.bypassManager.isActive('orchestrator') && typeof (orch as any).backfillUnclassified === 'function') {
          const currentSessionId = path.basename(this.sessionDir);
          const backfillUpto: number = (typeof (orch as any).getBackfillUpto === 'function')
            ? (orch as any).getBackfillUpto(currentSessionId)
            : 0;
          if (fullLineCount > backfillUpto) {
            const backfills: Array<{
              cluster_id: string; capability: string; summary: string;
              line_start: number; line_end: number; session_id: string;
            }> = await (orch as any).backfillUnclassified(currentSessionId);
            for (const bf of backfills) {
              if (!bf || !bf.cluster_id) continue;
              await this.eventStore.append(this.sessionDir, {
                type: 'cluster_assign',
                cluster_id: bf.cluster_id,
                capability: bf.capability,
                summary: bf.summary,
                line_start: bf.line_start,
                line_end: bf.line_end,
                timestamp: new Date().toISOString(),
              });
              await this.conversationStore.markCluster(
                this.sessionDir,
                bf.line_start,
                bf.line_end,
                bf.cluster_id,
              );
              // 回填块也可能超预算，顺带做簇级压缩
              await this.maybeCompressCluster(bf.cluster_id, bf.line_start, bf.line_end, bf.capability);
              this.logger?.info?.(
                `[cluster] backfilled "${bf.cluster_id}" (${bf.line_start}-${bf.line_end}, ${bf.capability})`,
              );
            }
          }
        }
      }

      // 每轮结束后回收已处理图片：旧 base64 → 占位符 + 模型描述
      if (!this.interrupted) {
        this.recycleProcessedImages().catch(() => {});
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // ── 钩子：回合异常（管道/LLM 抛错兜底通知） ──
      await this.loopHooks.emit('onTurnError', {
        turn: turnCount,
        error: error instanceof Error ? error : new Error(message),
      }).catch(() => {});
      this.outputHandler?.onStatus?.(
        `Agent error: ${message}`,
        'error',
      );
      throw error;
    } finally {
      // 清理中断监听
      process.removeListener('SIGINT', onSigInt);
      this.abortController = null;
    }
  }

  /**
   * 挂载插件到主循环（P1 M7）。返回 disposer：dispose() = 卸载。
   * 插件可通过 ctx.aroundHook('beforeToolExecute', ...) 拦截工具执行（权限链形态）、
   * ctx.onHook('onTurnStart', ...) 观察回合，卸载时钩子随生命周期账本自动摘除。
   */
  mountPlugin(
    plugin: HyPlugin<Record<string, unknown>, LoopHooks>,
    config?: Record<string, unknown>,
  ): Promise<Disposable> {
    return this.pluginHost.mount(plugin, config).then((disposer) => {
      // 安全内核 canary：每次插件挂载后核验守卫在位（防热重载/插件拆改）
      import('../kernel/security/index.js').then(({ verifySecurityIntegrity }) => {
        verifySecurityIntegrity();
      }).catch(() => {});
      return disposer;
    });
  }

  /**
   * 运行时替换阶段服务（扩展注册表 service:* 替换点的落点）。
   * 阶段模块经 ctx.get/require 读到的服务即此表；返回 disposer 恢复注册前值。
   */
  setStageService<K extends StageServiceKey>(key: K, value: StageServiceMap[K]): Disposable {
    const had = this.stageServices.has(key);
    const previous = this.stageServices.get(key);
    this.stageServices.set(key, value);
    return {
      dispose: () => {
        if (had) this.stageServices.set(key, previous);
        else this.stageServices.delete(key);
      },
    };
  }

  /**
   * 构造阶段执行上下文（每轮新建：iteration/signal/sessionDir 取当前值）。
   * get/require 从 stageServices 服务表读取；服务键与返回值类型受
   * StageServiceMap 编译期保护（拼错键 / 取错类型立即报错）。
   */
  private makeStageCtx(): KernelStageContext {
    return {
      iteration: this.currentTurn,
      signal: this.abortController?.signal,
      get: <K extends StageServiceKey>(key: K) =>
        this.stageServices.get(key) as StageServiceMap[K] | undefined,
      require: <K extends StageServiceKey>(key: K) => {
        const v = this.stageServices.get(key);
        if (v === undefined) {
          throw new Error(`[pipeline] missing stage service "${key}"`);
        }
        return v as StageServiceMap[K];
      },
      config: <T = Record<string, unknown>>() => ({}) as T,
      logger: this.logger,
    };
  }

  /**
   * 内部方法：执行一轮 LLM 调用
   */
  private async runTurn(): Promise<{ stop: boolean; stopReason?: string; toolCalled?: boolean }> {
    this.currentTurn++;
    // ── 钩子：回合开始 ──────────────────────────────────────────
    await this.loopHooks.emit('onTurnStart', { turn: this.currentTurn });
    // ── 验证证据账本：本轮复位（P1-B） ──
    this.turnEvidenceCount = 0;
    this.turnHadMutation = false;
    // ── 回合回滚：记录回合开始前状态 ──
    if (this.turnRecorder) {
      this.turnRecorder.startTurn(this.currentTurn).catch(err => {
        this.logger.warn('TurnRecorder startTurn failed', { error: (err as Error).message });
      });
    }
    // ── 全局陪伴模式同步 ──────────────────────────────────────────
    // 所有渠道共享同一份上下文路由。检测全局 Router 变化，
    // 自动切换当前 loop 的 sessionDir 和上下文行为。
    await this.syncRouter();

    // ── P1 M3：input 阶段（历史读入 + 输入归一化，经内核管道执行） ──
    const initState = createTurnState({
      turn: this.currentTurn,
      history: [],
      userInput: '',
      session: {
        sessionDir: this.sessionDir,
        currentSummary: this.currentSummary,
        recentToolNames: this.recentToolNames,
        activePlan: this.activePlan,
      } as SessionState,
    });
    initState.ephemeralInput = this.activeRouter.ephemeralInput ?? null;
    initState.companionMode = this.activeRouter.name === 'companion';
    this.stageServices.set('sessionDir', this.sessionDir);
    const st = await this.pipeline.runSlot('input', initState, this.makeStageCtx());
    const history = st.history;
    let userInputText = st.userInput;
    let stateRef: TurnState = st;
    // 纯旁白轮：模块已将瞬态输入并进 userInput 并置 null → 清空 router 上的残留
    if (st.ephemeralInput === null && initState.ephemeralInput !== null) {
      this.activeRouter.ephemeralInput = null;
    }

    // 输入归一化（userInput 提取 / 续轮判定 / 剥离 lastUser / 旁白覆盖 / 表达文本化）
    // 已下沉至 input 阶段模块，产物经 st 回传。此处保留 input 段的两个副作用：
    // 配置热更新应用 + 强制重压缩警告。
    // Apply runtime config changes if context is dirty
    if (this.configCenter && this.contextDirty) {
      const newThreshold = this.configCenter.get<number>('context.compressThreshold');
      if (newThreshold != null) {
        this.compressor.setCompressThreshold(newThreshold);
      }
      const newDepth = this.configCenter.get<number>('context.compressDepth');
      if (newDepth != null) {
        this.compressor.setCompressDepth(newDepth);
      }
      this.contextDirty = false;
    }

    // 切换到大窗口→小窗口模型后，强制全量重压缩
    if (this.clusterService.getNeedsCompression()) {
      this.outputHandler?.onStatus?.(
        `Forcing full context recompression to fit new model limit (${this.maxContextTokens.toLocaleString()})`,
        'warn',
      );
    }

    // 确定本轮实际使用的 Provider（路由决策前置，确保 compose 看到正确的 providerType）
    let activeProvider = this.provider;
    if (this.providerRouter) {
      // manual 模式（用户在 /model 显式选择、持久化在 provider.active）：直接用被
      // 钉住的实例，不走 route() 的自动路由 —— 否则启动时 defaultName 尚未设置，
      // route() 会按「medium → 优先本地」抢走用户选择，导致重启后模型静默回退。
      const routeMode = this.configCenter?.get<string>('provider.routeMode');
      if (routeMode === 'manual') {
        const pinnedName = this.configCenter?.get<string>('provider.active');
        activeProvider =
          (pinnedName ? this.providerRouter.get(pinnedName) : undefined) ??
          this.providerRouter.get('main') ??
          this.provider;
      } else {
        activeProvider = this.providerRouter.route({ complexity: 'medium' });
      }
    }
    this.activeProvider = activeProvider;

    // 一次性 fallback 通知（由 onFallback 回调写入，此处消费）
    if (this.pendingFallbackInfo) {
      this.outputHandler?.onStatus?.(
        this.pendingFallbackInfo,
        'warn',
      );
      this.pendingFallbackInfo = null;
    }

    // 一次性降级恢复通知（由 onRecover 回调写入，此处消费）
    if (this.pendingRecoverInfo) {
      this.outputHandler?.onStatus?.(
        this.pendingRecoverInfo,
        'info',
      );
      this.pendingRecoverInfo = null;
    }

    // ── P1 M6：bypass 阶段（preTurn 注入 / 意图消费 / 注入合并，经内核管道执行） ──
    stateRef = {
      ...stateRef,
      userInput: userInputText,
      bypassInjectionsCache: this._bypassInjections,
      intentLabel: this._currentIntent,
      lastContextTokens: this.lastContextTokens,
      recentToolNames: this.recentToolNames,
    };
    const bt = await this.pipeline.runSlot('bypass', stateRef, this.makeStageCtx());
    // 回读 bypass 产物与副作用
    userInputText = bt.userInput;
    this._bypassInjections = bt.bypassInjectionsCache;
    this._currentIntent = bt.intentLabel;
    stateRef = bt;

    // ── P1 M4：context 阶段（工具过滤 / effectiveHistory / 图片注入 / kb / cluster /
    //    compose / 压缩消费与触发，经内核管道执行；bypass preTurn 注入已在上面归位） ──
    stateRef = {
      ...stateRef,
      userInput: userInputText,
      summary: this.currentSummary,
      impactInfo: this.pendingImpactInfo,
      needsCompression: this.clusterService.getNeedsCompression(),
      needsAggressiveCompress: this.needsAggressiveCompress,
      pendingCompression: this.pendingCompression,
      compressCount: this.compressCount,
      lastSavedSummary: this.lastSavedSummary,
      lastContextTokens: this.lastContextTokens,
      activeProvider,
      bypassInjections: bt.bypassInjections,
      activePlan: this.activePlan,
      pendingImageInjections: this.pendingImageInjections,
      pendingMediaInjections: this.pendingMediaInjections,
    };
    this.stageServices.set('sessionDir', this.sessionDir);
    const ct = await this.pipeline.runSlot('context', stateRef, this.makeStageCtx());
    // 回读 context 产物与副作用（压缩/摘要/激进压缩标记等由模块写入 state）
    const messages = ct.messages;
    const toolDefinitions = ct.toolDefinitions;
    this.lastContextTokens = ct.lastContextTokens;
    this.clusterService.setNeedsCompression(ct.needsCompression);
    this.needsAggressiveCompress = ct.needsAggressiveCompress;
    this.pendingCompression = ct.pendingCompression;
    this.compressCount = ct.compressCount;
    this.currentSummary = ct.summary;
    this.lastSavedSummary = ct.lastSavedSummary;
    this.pendingImpactInfo = ct.impactInfo; // 已消费 → null
    this.activeProvider = activeProvider;
    // 图片/媒体注入消费：原地清空（view_image/view_media 工具持有原数组引用，重赋值会断引用）
    this.pendingImageInjections.length = 0;
    this.pendingMediaInjections.length = 0;
    stateRef = ct;

    // ── P1 M5：llm 阶段（thinking / createStream / 流消费 / 去重 / scavenge / stats /
    //    assistant 落盘，经内核管道执行；中断判定用 ctx.signal） ──
    stateRef = {
      ...stateRef,
      streamText: '',
      toolCalls: [],
      stopReason: undefined,
      cacheStats: {
        hitTokens: 0,
        missTokens: 0,
        turns: [...this.cacheTurns],
        logHits: this.logCacheHits,
      },
      inlineToolExecuted: false,
      inlineToolResults: this.inlineToolResults,
    };
    const lt = await this.pipeline.runSlot('llm', stateRef, this.makeStageCtx());
    // 回读 llm 产物与副作用
    const textParts = lt.streamText ? [lt.streamText] : [];
    const toolCalls = lt.toolCalls;
    this.cacheHitTokens = lt.cacheStats.hitTokens;
    this.cacheMissTokens = lt.cacheStats.missTokens;
    this.cacheTurns = lt.cacheStats.turns;
    this.logCacheHits = lt.cacheStats.logHits;
    this.inlineToolExecuted = lt.inlineToolExecuted;
    // 累计输入/输出 token 总量（stats 只落盘会话累计；这里维护 loop 生命周期内
    // 的真实累计，供 TUI 显示。usage 缺失（provider 不返回）时维持原值）
    if (typeof lt.usageInput === 'number' && lt.usageInput > 0) this.totalInputTokens += lt.usageInput;
    if (typeof lt.usageOutput === 'number' && lt.usageOutput > 0) this.totalOutputTokens += lt.usageOutput;
    stateRef = lt;

    // 如果有工具调用，执行工具并将结果追加到 conversation
    if (toolCalls.length > 0) {
      // ── P1 M5：tools 阶段（钩子 / recentToolNames / plan 更新 / inline flush 或 executeTools） ──
      const tt = await this.pipeline.runSlot('tools', stateRef, this.makeStageCtx());
      // 回读 tools 副作用
      this.recentToolNames = tt.recentToolNames;
      this.activePlan = tt.activePlan;
      this.inlineToolExecuted = tt.inlineToolExecuted;
      this.inlineToolResults = tt.inlineToolResults;
      stateRef = tt;

      // 工具执行完毕后，不停止，继续下一轮
      await this.checkTextLoop(textParts);
      // ── P1 M3：finalize 阶段（endTurn + stop 判定，经内核管道执行） ──
      // report 提交/中止状态预填（消费即重置）：判停由 finalize 在 toolCalled 之前完成
      const finA = await this.pipeline.runSlot('finalize', { ...stateRef, toolCalled: true, sayStatus: await this.takeSayStatus() }, this.makeStageCtx());
      // ── 钩子：迭代结束（stop 判定已出） ──
      await this.loopHooks.emit('beforeIterationEnd', { turn: this.currentTurn, stop: finA.stop, stopReason: finA.stopReason });
      // ── 验证门（P0-3）：plan_execute 预测落空后禁止直接结束 ──
      const gatedA = await this.applyVerificationGate(finA.stop, finA.stopReason);
      // ── 证据门（P1-B）：改了却不验证，不许直接结束 ──
      const gatedA2 = await this.applyEvidenceGate(gatedA.stop, gatedA.stopReason);
      return { stop: gatedA2.stop, stopReason: gatedA2.stopReason, toolCalled: finA.toolCalled };
    }

    // 没有 tool_calls —— 先检查 Flow 状态机是否仍在运行。
    // 若 flow 活跃（即使本轮 LLM 失误没调 flow_complete），不终止主循环：
    // 下一轮 Zone 5 注入 flow 状态，引导 LLM 继续推进。
    // flowRegistry 是可选服务（factory 注入，子 Agent 不传）。
    // 子 Agent 的 AgentLoop 无 flowRegistry，必须可选链，否则 undefined.getActive() 崩溃。
    const flowStillActive = this.flowRegistry?.getActive();
    await this.checkTextLoop(textParts);
    // ── P1 M3：finalize 阶段（endTurn + stop 判定；flow 活跃时不写 stop 事件） ──
    const finB = await this.pipeline.runSlot('finalize', { ...stateRef, flowStillActive: !!flowStillActive }, this.makeStageCtx());
    // ── 钩子：迭代结束（stop 判定已出） ──
    await this.loopHooks.emit('beforeIterationEnd', { turn: this.currentTurn, stop: finB.stop, stopReason: finB.stopReason });
    // ── 验证门（P0-3）：plan_execute 预测落空后禁止直接结束 ──
    const gatedB = await this.applyVerificationGate(finB.stop, finB.stopReason);
    // ── 证据门（P1-B）：改了却不验证，不许直接结束 ──
    const gatedB2 = await this.applyEvidenceGate(gatedB.stop, gatedB.stopReason);
    return { stop: gatedB2.stop, stopReason: gatedB2.stopReason, toolCalled: finB.toolCalled };
  }

  /**
   * 检测本轮文本输出是否陷入循环。
   * 在 assistant 消息和工具结果全部写入 conversation 后调用，
   * 确保反射消息位于本轮对话末尾，下一轮 compose 时 LLM 能正确感知上下文。
   */
  private async checkTextLoop(textParts: string[]): Promise<void> {
    const textLoopEnabled = this.configCenter
      ? (this.configCenter.get('repair.textLoop.enabled') as boolean)
      : true;
    if (textLoopEnabled === false || textParts.length === 0) return;

    const fullText = textParts.join('');
    const { loop, reflection } = this.loopGuard.checkTextOutput(fullText);
    if (loop && reflection) {
      const loopMsg: Message = {
        role: 'user',
        content: { type: 'text', text: reflection },
      };
      await this.conversationStore.append(this.sessionDir, loopMsg);
      this.outputHandler?.onStatus?.(reflection, 'warn');
      // 文本循环连续触发：直接标记强制 stop（与工具抑制共享 escalated 判断）
      // LoopGuard.escalated 由 guardCount 驱动，checkTextOutput 已累加
    }
  }

  /**
   * 循环级验证门（P0-3）：plan_execute 预测落空后，模型不应在未修复时直接结束。
   * 由 repair.verification.mode 控制：
   *  - 'off'（默认）：不干预
   *  - 'soft'：注入失败消息到对话（下一轮模型可见），不强制
   *  - 'hard'：注入失败消息并强制继续（stop=false），直到不再产生 handoff
   */
  private async applyVerificationGate(
    stop: boolean,
    stopReason?: string,
  ): Promise<{ stop: boolean; stopReason?: string }> {
    const mode = this.configCenter?.get('repair.verification.mode') as 'off' | 'soft' | 'hard' | undefined;
    if (!mode || mode === 'off') return { stop, stopReason };
    // report 显式交付优先于自动校验：模型已明确"结论交给用户"，不应被验证门拽回继续
    if (stopReason === 'say_submitted' || stopReason === 'say_failed') return { stop, stopReason };
    if (!this.planHandoff.pending) return { stop, stopReason };

    const reason = this.planHandoff.pending;
    const verificationMsg: Message = {
      role: 'user',
      content: {
        type: 'text',
        text: `[Verification] 上一步 plan_execute 的预测落空（已交回主流程）：${reason}\n验证模式 ${mode}：请先修复该步的断言失败，不要直接宣布完成。`,
      },
    };
    await this.conversationStore.append(this.sessionDir, verificationMsg);
    this.outputHandler?.onStatus?.('Verification gate: plan_execute prediction failed, injected failure message', 'warn');
    this.planHandoff.pending = null; // 消费一次；hard 模式下新的 handoff 会再次置位

    if (mode === 'hard') {
      return { stop: false, stopReason: 'verification_pending' };
    }
    return { stop, stopReason }; // soft：仅注入消息，不强制
  }

  /**
   * 验证证据门（P1-B）：本轮修改了文件但没有任何验证证据（测试/编译/lint/typecheck）时，
   * 不允许直接结束。repair.evidenceGate：off=不干预；soft=注入消息；
   * hard=注入并强制继续。验证证据 = bash 跑过验证类命令（tools/evidence.ts）。
   */
  private async applyEvidenceGate(
    stop: boolean,
    stopReason?: string,
  ): Promise<{ stop: boolean; stopReason?: string }> {
    const mode = this.configCenter?.get('repair.evidenceGate.mode') as 'off' | 'soft' | 'hard' | undefined;
    if (!mode || mode === 'off') return { stop, stopReason };
    // 同验证门：report 显式交付优先（否则"改了文件没验证"会把已汇报的回合拽回继续）
    if (stopReason === 'say_submitted' || stopReason === 'say_failed') return { stop, stopReason };
    if (!this.turnHadMutation || this.turnEvidenceCount > 0) return { stop, stopReason };
    if (!stop) return { stop, stopReason };

    const evidenceMsg: Message = {
      role: 'user',
      content: {
        type: 'text',
        text: '[Evidence] 本轮修改了文件但没有产生任何验证证据（测试/编译/lint/typecheck）。请先运行验证（如 npm test / tsc --noEmit / cargo test），确认改动正确后再结束。',
      },
    };
    await this.conversationStore.append(this.sessionDir, evidenceMsg);
    this.outputHandler?.onStatus?.('Evidence gate: mutation without verification, injected evidence message', 'warn');

    if (mode === 'hard') {
      return { stop: false, stopReason: 'evidence_pending' };
    }
    return { stop, stopReason }; // soft：仅注入消息，不强制
  }

  /** 构造工具执行上下文（B1：每轮取当前值；可变状态经访问器读写） */
  private makeToolExecContext(): ToolExecContext {
    return {
      outputHandler: this.outputHandler,
      sessionDir: this.sessionDir,
      turn: this.currentTurn,
      loopHooks: this.loopHooks,
      turnRecorder: this.turnRecorder,
      dependencyAnalyzer: this.dependencyAnalyzer,
      // 引用分析能力（Phase 6）：插件经 ctx.register 注册、卸载自动摘除；
      // 这里**每回合现取**（ctx 字面量在每次工具批次时构造）⇒ 挂载/卸载即时生效，
      // 取不到（xref 未挂载）时消费侧自动退核心兜底。
      referenceAnalysis: this.pluginHost.get('referenceAnalysis') as
        | import('../tools/reference-analysis.js').ReferenceAnalysisCapability
        | undefined,
      gitManager: this.gitManager,
      conversationStore: this.conversationStore,
      configCenter: this.configCenter,
      toolExecutor: this.toolExecutor,
      toolRegistry: this.toolRegistry,
      resultBuffer: this.resultBuffer,
      abortController: this.abortController,
      dangerousTools: this.dangerousTools,
      allowlistTools: this.allowlistTools,
      allowedCommands: this.allowedCommands,
      loopGuard: this.loopGuard,
      getUnrestricted: () => this.unrestrictedTools,
      setUnrestricted: (v) => { this.unrestrictedTools = v; },
      getPendingImpact: () => this.pendingImpactInfo,
      setPendingImpact: (v) => { this.pendingImpactInfo = v; },
      markMutation: () => { this.turnHadMutation = true; },
      hadMutation: () => this.turnHadMutation,
      addEvidence: () => { this.turnEvidenceCount += 1; },
      evidenceCount: () => this.turnEvidenceCount,
      inlineToolResults: this.inlineToolResults,
      // 执行侧工具包对称校验（治本）：从 bundleRegistry 派生"是否在激活包内"。
      // undefined（未注入 bundleRegistry，如子 Agent）→ 不拦截，保持既有行为。
      isToolAllowedByBundle: this.bundleRegistry
        ? (name: string) => {
            // 全量模式（无限制）或激活包为空 → 放行（与组装侧 context.ts 语义一致）
            if (this.bundleRegistry!.isAllMode()) return true;
            const active = this.bundleRegistry!.getActiveToolNames();
            if (active.length === 0) return true;
            return active.includes(name);
          }
        : undefined,
    };
  }

  /**
   * 回收已处理图片：将非最后一轮的 image base64 替换为占位符。
   *
   * - 保留最后一条 user 消息中的图片（模型当前轮还在看）
   * - 更早的图片 → 用模型后续的回复作为描述，替换为纯文本占位符
   * - 无模型描述时 → 用元信息占位符
   * - 替换后的占位符包含 img_id，模型可通过 view_image 重新查看
   */
  /** 回收已处理图片：替换为可回溯文本占位符（B5 拆出至 loop-image.ts） */
  async recycleProcessedImages(): Promise<void> {
    return recycleImagesFromHistory({
      getConversationStore: () => this.conversationStore,
      getSessionDir: () => this.sessionDir,
      getImageStore: () => this.imageStore,
    });
  }

  /** 释放资源：停路由器（含 WorldEngine）+ 停调度器 */
  async shutdown(): Promise<void> {
    await this.activeRouter.onDeactivate?.(this).catch(() => {});
    await this.scheduler?.stop();
  }

  // ── 意图簇 + deep 压缩模板恢复（B3 拆出至 loop-cluster.ts；
  //    状态与消费入口已收敛为 clusterService，此处仅保留 deps 快照构造） ──

  /** 构造簇压缩族依赖快照（每轮现取当前值，mutable 字段实时读取） */
  private makeClusterDeps() {
    return {
      sessionDir: this.sessionDir,
      compressor: this.compressor,
      conversationStore: this.conversationStore,
      eventStore: this.eventStore,
      summaryStore: this.summaryStore,
      configCenter: this.configCenter,
      maxContextTokens: this.maxContextTokens,
      getCurrentIntentCapability: () => this.getCurrentIntentCapability(),
      logger: this.logger,
    };
  }

  /** 簇级压缩：检查指定簇是否超限，超限则压缩并存簇摘要（B3 拆出） */
  private async maybeCompressCluster(
    clusterId: string,
    lineStart: number,
    lineEnd: number,
    capability: string,
  ): Promise<void> {
    return maybeCompressCluster(this.makeClusterDeps(), clusterId, lineStart, lineEnd, capability);
  }

  /** 从 events.jsonl 回放 cluster_assign 事件，重建簇索引（B3 拆出） */
  private async loadClusterIndex(): Promise<Array<{
    cluster_id: string; capability: string; summary: string;
    line_start: number; line_end: number;
  }>> {
    return loadClusterIndex(this.makeClusterDeps());
  }

  // ── trigger_compression 工具入口（闭包触手正规化：工具层不再 as any 写私有字段） ──

  /** 写入 deep 压缩临时模板状态（level=deep 时工具调用） */
  setDeepCompressState(state: DeepCompressState): void {
    this.clusterService.setDeepCompressState(state);
  }

  /** 置位/复位强制重压缩标记（压缩完成后自动复位） */
  setNeedsCompression(v: boolean): void {
    this.clusterService.setNeedsCompression(v);
  }
}
