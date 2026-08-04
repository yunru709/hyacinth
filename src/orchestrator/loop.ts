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
import { appendEvent } from '../event-store.js';
import type { StatsManager } from '../memory/stats.js';
import type { SummaryStore } from '../memory/summary.js';
import type { Message, MessageContent, ToolCall, TextContent, ThinkingContent, ToolUseContent, ToolResultContent } from '../types.js';
import { OutputRouter } from '../parser/router.js';
import { LLMOrchestrator } from './planner.js';
import type { Plan } from './plan-store.js';
import { formatPlanAsText } from './plan-store.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { MCPBridge } from '../mcp/bridge.js';
import type { DependencyAnalyzer } from '../dependency/analyzer.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { LifecycleSupervisor } from '../lifecycle/supervisor.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ImageStore, buildUserContentWithImages, buildUserContentWithInlineImages, createViewImageTool } from '../multimodal/index.js';
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
import { scavengeToolCalls } from '../repair/scavenge.js';
import { ToolResultBuffer } from '../tools/result-buffer.js';
import { sanitizeToolResult } from '../tools/injection-filter.js';
import type { ComposeStrategy } from '../context/precision/index.js';
import { getActiveProfile, getActiveRouter, type ContextProfile } from '../context/profiles.js';
import type { IContextRouter } from '../context/router.js';
import { NormalRouter } from '../context/router.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { GitManager } from '../evolution/git-manager.js';
import { extractTextContent } from '../utils/misc.js';
import type { TurnRecorder } from '../rollback/turn-recorder.js';
import * as sessionAllowlist from '../memory/session-allowlist.js';

/** Format a Date as YYYY-MM-DD HH:mm (cache-friendly, minute precision) */
function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d} ${h}:${min}`;
}

/** 从末尾累加消息，直到累计 token 数超过 budget，返回保护条数 */
function computeProtectCount(messages: Message[], tokenBudget: number): number {
  // 使用简化的 char/4 估算
  let tokens = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const rawContent = messages[i].content;
    const text: string = typeof rawContent === 'string'
      ? rawContent
      : JSON.stringify(rawContent);
    tokens += Math.ceil(text.length / 4) + 4; // +4 for role/overhead
    count++;
    if (tokens >= tokenBudget) break;
  }
  return Math.max(2, count); // 至少保护 2 条
}

/** 判断两条消息是否具有相同的 role 和 text content */
function isSameTextMessage(a: Message, b: Message): boolean {
  if (a.role !== b.role) return false;
  const aContents = Array.isArray(a.content) ? a.content : [a.content];
  const bContents = Array.isArray(b.content) ? b.content : [b.content];
  if (aContents.length !== bContents.length) return false;
  for (let i = 0; i < aContents.length; i++) {
    const ac = aContents[i];
    const bc = bContents[i];
    if (ac.type !== bc.type) return false;
    if (ac.type === 'text') {
      if ((ac as any).text !== (bc as any).text) return false;
    } else if (ac.type === 'image') {
      const aSrc = (ac as any).source;
      const bSrc = (bc as any).source;
      if (aSrc?.type !== bSrc?.type) return false;
      if (aSrc?.type === 'base64' && aSrc?.data !== bSrc?.data) return false;
      if (aSrc?.type === 'url' && aSrc?.url !== bSrc?.url) return false;
    } else {
      // For other types (tool_use, tool_result, thinking), compare serialized
      if (JSON.stringify(ac) !== JSON.stringify(bc)) return false;
    }
  }
  return true;
}

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
  /** Request user permission for dangerous tool execution. Returns 'yes' (once), 'no' (deny), 'always' (add to allowlist), or 'aor' (unrestricted — skip all future checks). */
  onPermissionRequest?(toolName: string, input: Record<string, unknown>): Promise<'yes' | 'no' | 'always' | 'aor'>;
  /** Ask the user structured questions with options. Each question supports multi-select and custom input.
   *  Returns a JSON string mapping question index → selected answers. */
  onAskUser?(questions: AskUserQuestion[]): Promise<string>;
}

/** A single question for ask_user */
export interface AskUserQuestion {
  question: string;
  header?: string;
  options?: string[];
  multiSelect?: boolean;
  customInput?: boolean;
}

/** Per-turn cache hit statistics */
export interface CacheTurnRecord {
  turn: number;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  hitTokens: number;
  missTokens: number;
  hitRate: number;
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
 * AgentLoop — 串联所有模块的完整 Agent 主循环
 *
 * 核心流程：compose -> LLM -> parse -> tool -> compose 的循环
 *
 * 通过 OutputHandler 接口解耦输出：
 * - 传 null → 无输出（静默模式）
 * - 传实现 → 输出到 TUI / CLI / 日志 等任意目标
 */
export class AgentLoop {
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
  private compressCount = 0;
  private needsAggressiveCompress = false;
  private cacheHitTokens = 0;
  private cacheMissTokens = 0;
  private cacheTurns: CacheTurnRecord[] = [];
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
  /** 渠道预取图片（渠道层在 run() 前写入，_runInternal 一次性消费） */
  channelImages: Array<{ data: string; media_type: string }> | null = null;
  /** Fallback 通知（onFallback 回调写入，runTurn 一次性消费后清空） */
  pendingFallbackInfo: string | null = null;
  /** 降级链恢复主 Provider 通知（onRecover 回调写入，runTurn 一次性消费后清空） */
  pendingRecoverInfo: string | null = null;
  /** 上下文组装策略（精确模式切换用，deprecated：新代码使用 activeRouter） */
  composeStrategy: ComposeStrategy | null = null;
  /** 当前激活的上下文路由器，初始化为 NormalRouter，首次 syncRouter() 时同步到全局状态 */
  activeRouter: IContextRouter = new NormalRouter();
  /** Whether any tools were executed inline during the current stream */
  private inlineToolExecuted = false;
  /** Stores results from inline tool execution, keyed by tool_use_id */
  private inlineToolResults: Map<string, { content: string; isError: boolean }> = new Map();
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
  private bypassProvider?: Provider;
  private lastContextTokens = 0;
  private needsCompression = false;
  private pendingCompression: Promise<CompressionResult | null> | null = null;
  // deep compression: 临时替换 summary.md 后的恢复标记
  private _deepCompressOriginal: string | null = null;
  private _deepCompressRestore = false;

  private lifecycleSupervisor: LifecycleSupervisor | null = null;
  private previousProviderWasLocal = false;
  /** 当前 AgentLoop 的 thinking 状态（per-session 隔离） */
  private thinkingEnabled: boolean = false;
  private thinkingEffort: string | number | undefined = undefined;

  constructor(
    private provider: Provider,
    private contextComposer: LayeredContextComposer,
    private compressor: CompressorOrchestrator,
    orchestrator: LLMOrchestrator,
    private toolExecutor: ToolExecutor,
    private toolRegistry: ToolRegistry,
    private conversationStore: ConversationStore,
    private eventStore: EventStore,
    private statsManager: StatsManager,
    private sessionDir: string,
    private summaryStore: SummaryStore,
    private maxTurns: number = getDefaultConfig().session.maxTurns,
    private maxContextTokens: number,
    outputHandler?: OutputHandler | null,
    private skillRegistry?: SkillRegistry,
    private mcpBridge?: MCPBridge,
    private dependencyAnalyzer?: DependencyAnalyzer,
    agentRegistry?: AgentRegistry,
    private personaDir?: string,
    flowRegistry?: MachineRegistry,
    private providerRouter?: ProviderRouter,
    dangerousTools?: Set<string>,
    allowlistTools?: Set<string>,
    configCenter?: RuntimeConfigCenter,
    private modelRouter?: ModelRouter,
    private turnRecorder?: TurnRecorder,
  ) {
    this.orchestrator = orchestrator;
    this.outputHandler = outputHandler ?? null;
    this.agentRegistry = agentRegistry;
    // MachineRegistry 由 factory.ts 注入，不创建默认实例（空注册表无实际作用）
    this.flowRegistry = flowRegistry!;
    this.dangerousTools = dangerousTools ?? new Set(['write', 'bash']);
    this.allowlistTools = allowlistTools ?? new Set();
    this.configCenter = configCenter;
    this.maxContextTokens = configCenter
      ? configCenter.get<number>('session.maxContext')
      : DEFAULT_MAX_CONTEXT_TOKENS;
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

      // Restore dangerousTools
      const persistedDangerousTools = this.configCenter.get('safety.dangerousTools') as unknown as string[] | undefined;
      if (Array.isArray(persistedDangerousTools)) {
        this.dangerousTools = new Set(persistedDangerousTools);
      }

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
        this.dangerousTools = new Set(event.newValue as string[]);
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

    // ── 注册 view_image 工具（依赖 ImageStore） ──
    this.toolRegistry.register(
      createViewImageTool(this.imageStore, this.pendingImageInjections),
    );
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
    // Latest turn cache hit rate
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
      cacheHistory: this.cacheTurns.length > 0 ? [...this.cacheTurns] : undefined,
    };
  }

  private getRecentToolCallNames(): string[] {
    return this.recentToolNames;
  }

  /** 就地切换到指定 session，无需重启进程 */
  async switchSession(newSessionDir: string): Promise<void> {
    this.sessionDir = newSessionDir;
    this.currentSummary = undefined;
    this.compressCount = 0;
    this.needsAggressiveCompress = false;
    this.inlineToolResults.clear();
    this.pendingImpactInfo = null;
    this.pendingTaskNotifications = [];
    this.pendingCompression = null;
    this._deepCompressOriginal = null;
    this._deepCompressRestore = false;
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
   * 陪伴模式：从 JSONL 中移除本轮工具调用完整回合。
   * 找到最后一条 user 文本消息，从它开始截断文件——
   * 整个工具调用回合（user → tool_use → tool_result → 跟进文本）都不留痕迹。
   */
  private async removeLastRoundFromJsonl(): Promise<void> {
    try {
      const jsonlPath = path.join(this.sessionDir, 'conversation.jsonl');
      const fsSync = await import('node:fs');
      if (!fsSync.existsSync(jsonlPath)) return;

      const content = fsSync.readFileSync(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length === 0) return;

      // 从末尾往前找本轮第一个 tool_use assistant 消息
      let firstToolUse = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.role === 'assistant' && Array.isArray(msg.content) &&
              msg.content.some((b: any) => b.type === 'tool_use')) {
            firstToolUse = i;
          } else if (firstToolUse !== -1) {
            break; // 遇到非 tool_use 消息，本轮的 tool 区域结束
          }
        } catch { /* skip */ }
      }

      if (firstToolUse === -1) return;

      // 从 tool_use 往前找到触发它的 user 文本消息（排除 tool_result）
      let cutIndex = firstToolUse;
      for (let i = firstToolUse - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.role === 'user') {
            const c = msg.content;
            if (!Array.isArray(c) || !c.some((b: any) => b.type === 'tool_result')) {
              cutIndex = i;
              break;
            }
          }
        } catch { /* skip */ }
      }

      // 截断：保留 cutIndex 之前的所有行
      const kept = lines.slice(0, cutIndex);
      const newContent = kept.length > 0 ? kept.join('\n') + '\n' : '';
      fsSync.writeFileSync(jsonlPath, newContent, 'utf-8');
    } catch { /* 文件操作失败不阻塞 */ }
  }

  /**
   * 陪伴模式工具调用清理：
   * - companion_mode 切换 → 剥离工具痕迹，保留 LLM 文本
   * - 其他工具 → 整轮砍掉（原有行为）
   * - 找不到触发消息（跨 session） → 处理整个文件
   */
  private async cleanCompanionJsonl(): Promise<void> {
    try {
      const jsonlPath = path.join(this.sessionDir, 'conversation.jsonl');
      const fsSync = await import('node:fs');
      if (!fsSync.existsSync(jsonlPath)) return;

      const content = fsSync.readFileSync(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length === 0) return;

      // 从末尾往前找最后一条纯文本 user 消息
      let triggerIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.role !== 'user') continue;
          const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
          if (blocks.every((b: any) => b.type === 'tool_result')) continue;
          triggerIdx = i;
          break;
        } catch { /* skip */ }
      }

      // 检查是否有 companion_mode 工具（跨 session 时从 0 开始扫描）
      let hasCompanionModeTool = false;
      const scanFrom = triggerIdx === -1 ? 0 : triggerIdx;
      for (let i = scanFrom; i < lines.length; i++) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.role !== 'assistant') continue;
          const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
          if (blocks.some((b: any) => b.type === 'tool_use' && b.name === 'companion_mode')) {
            hasCompanionModeTool = true;
            break;
          }
        } catch { /* skip */ }
      }

      // companion_mode 切换：剥离 tool 痕迹，保留 LLM 文本
      if (hasCompanionModeTool) {
        const processFrom = triggerIdx === -1 ? 0 : triggerIdx + 1;
        const kept: string[] = [];
        for (let i = 0; i < processFrom; i++) kept.push(lines[i]);
        for (let i = processFrom; i < lines.length; i++) {
          try {
            const msg = JSON.parse(lines[i]);
            if (msg.role === 'user') {
              const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
              if (blocks.some((b: any) => b.type === 'tool_result')) continue;
              kept.push(lines[i]);
              continue;
            }
            if (msg.role === 'assistant') {
              const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
              // 跳过包含 companion_mode tool_use 的消息（确认语如 "好的，进入陪伴模式。"）
              if (blocks.some((b: any) => b.type === 'tool_use' && b.name === 'companion_mode')) continue;
              const textBlocks = blocks.filter((b: any) => b.type === 'text');
              if (textBlocks.length === 0) continue;
              kept.push(JSON.stringify({
                role: 'assistant',
                content: textBlocks.length === 1 ? textBlocks[0] : textBlocks,
              }));
              continue;
            }
            kept.push(lines[i]);
          } catch { /* skip */ }
        }
        fsSync.writeFileSync(jsonlPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');
        return;
      }

      // 普通工具：整轮砍掉
      if (triggerIdx !== -1) {
        const kept = lines.slice(0, triggerIdx);
        fsSync.writeFileSync(jsonlPath, kept.length ? kept.join('\n') + '\n' : '', 'utf-8');
      }
    } catch { /* 文件操作失败不阻塞 */ }
  }

  /**
   * 陪伴模式定时任务专用：只移除触发提示词和工具链，保留模型自然回复。
   * 效果：模型看起来像是"主动"搭话，而非响应系统指令。
   */
  private async removeTriggerFromJsonl(): Promise<void> {
    try {
      const jsonlPath = path.join(this.sessionDir, 'conversation.jsonl');
      const fsSync = await import('node:fs');
      if (!fsSync.existsSync(jsonlPath)) return;

      const content = fsSync.readFileSync(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length === 0) return;

      // 从末尾找最后一条 user 文本消息（触发提示词）
      let triggerIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.role !== 'user') continue;
          const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];
          if (blocks.every((b: any) => b.type === 'tool_result')) continue;
          triggerIdx = i;
          break;
        } catch { /* skip */ }
      }

      if (triggerIdx === -1) return;

      // 收集要移除的索引：触发词 + 之后所有的 tool_use / tool_result
      const removeIndices = new Set<number>();
      removeIndices.add(triggerIdx);

      for (let i = triggerIdx + 1; i < lines.length; i++) {
        try {
          const msg = JSON.parse(lines[i]);
          const blocks: any[] = Array.isArray(msg.content) ? msg.content : [msg.content];

          if (msg.role === 'assistant' && blocks.some((b: any) => b.type === 'tool_use')) {
            removeIndices.add(i);
          }
          if (msg.role === 'user' && blocks.every((b: any) => b.type === 'tool_result')) {
            removeIndices.add(i);
          }
        } catch { /* skip */ }
      }

      const kept = lines.filter((_, i) => !removeIndices.has(i));
      const newContent = kept.length > 0 ? kept.join('\n') + '\n' : '';
      fsSync.writeFileSync(jsonlPath, newContent, 'utf-8');
    } catch { /* 文件操作失败不阻塞 */ }
  }

  /**
   * 同步全局 Router 到当前 loop。
   * 每轮 runTurn 开头调用，所有渠道的 loop 自动切换会话和上下文行为。
   */
  async syncRouter(): Promise<void> {
    const globalRouter = getActiveRouter();
    if (this.activeRouter?.name === globalRouter.name) return;

    // 切出旧 Router
    if (this.activeRouter) {
      await this.activeRouter.onDeactivate?.(this);
    }

    // 切入新 Router
    this.activeRouter = globalRouter;
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

  /** 注入工具包注册表（在 factory.ts 中紧接 AgentLoop 创建后调用） */
  setBundleRegistry(registry: ToolBundleRegistry): void {
    this.bundleRegistry = registry;
  }

  /** 运行时替换 outputHandler（用于 server 模式按请求切换流式输出） */
  setOutputHandler(handler: OutputHandler): void {
    this.outputHandler = handler;
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

  /** 由 factory 注入：旁路Agent 共享的 Provider 实例 */
  setBypassProvider(provider: Provider): void {
    this.bypassProvider = provider;
  }

  /** 获取当前意图簇 capability（用于簇摘要读取与历史过滤）。无意图时返回 'general'。 */
  getCurrentIntentCapability(): string {
    if (!this._currentIntent) return 'general';
    return this._currentIntent.match(/^\[(\w+)\]/)?.[1] ?? 'general';
  }

  /** 运行时切换旁路Agent 的 KVCache 隔离 ID（与主Agent 同步切换） */
  setBypassUserId(userId: string): void {
    this.bypassProvider?.setUserId?.(userId);
  }

  /** 切换 Provider 路由模式 */
  toggleProvider(): void {
    if (!this.providerRouter) return;
    const info = this.providerRouter.getRoutingInfo();
    if (info.mode === 'manual') {
      this.providerRouter.clearDefault();
    } else {
      const localProviders = this.providerRouter.list().filter(name => {
        const p = this.providerRouter?.get(name);
        const t = p?.getProviderType();
        return t === 'llamacpp' || t === 'local' || t === 'ollama';
      });
      const onlineProviders = this.providerRouter.list().filter(name => {
        const p = this.providerRouter?.get(name);
        const t = p?.getProviderType();
        return t !== 'llamacpp' && t !== 'local' && t !== 'ollama';
      });
      if (info.isLocal && onlineProviders.length > 0) {
        this.providerRouter.setDefault(onlineProviders[0]);
        // 从本地切走 → 停止本地模型
        if (this.lifecycleSupervisor) {
          const modelKey = this.configCenter?.get('provider.local.modelKey') as string || '';
          this.lifecycleSupervisor.stopModel(modelKey).catch(() => {});
        }
        this.previousProviderWasLocal = false;
      } else if (!info.isLocal && localProviders.length > 0) {
        this.providerRouter.setDefault(localProviders[0]);
        if (this.lifecycleSupervisor) {
          const existingBaseUrl = this.configCenter?.get('provider.local.baseUrl') as string;
          if (!existingBaseUrl) {
            const modelKey = this.configCenter?.get('provider.local.modelKey') as string || '';
            this.lifecycleSupervisor.startModelOnDemand(process.cwd(), modelKey)
              .then((modelInfo) => {
                if (modelInfo) {
                  this.lifecycleSupervisor?.getModelManager().getModels();
                }
              })
              .catch(() => {});
          }
        }
        this.previousProviderWasLocal = true;
      }
    }
  }

  /** 切换到指定名称的 Provider */
  /** 注册新 Provider（用于 switch_provider 工具带 api_key 动态注册） */
  registerProvider(name: string, provider: Provider): void {
    this.providerRouter?.register(name, provider);
  }

  async switchProvider(providerName: string): Promise<void> {
    if (this.switchingProvider) return;
    if (!this.providerRouter) {
      throw new Error('ProviderRouter not available');
    }

    this.switchingProvider = true;
    try {

    let newProvider = this.providerRouter.get(providerName);

    if (!newProvider && this.configCenter) {
      // 本地模型：跳过 configCenter，始终自动检测
      if (providerName === 'local' || providerName === 'llamacpp' || providerName === 'ollama') {
        const { getLocalProviderConfigLoader, detectLocalBackend } = await import('../provider/local-config.js');
        const localCfg = getLocalProviderConfigLoader();
        let detected = await detectLocalBackend();

        // 未检测到运行中的服务 → 尝试自动拉起（通过 lifecycle supervisor 管理进程）
        if (!detected && this.lifecycleSupervisor) {
          // 先试 Ollama
          const ollamaInfo = await this.lifecycleSupervisor.startOllamaOnDemand(process.cwd());
          if (ollamaInfo) {
            detected = { backend: 'ollama', baseUrl: ollamaInfo.baseUrl, port: ollamaInfo.port ?? 11434 };
          } else {
            // 再试 llama.cpp
            const { getLocalProviderConfigLoader: getCfg } = await import('../provider/local-config.js');
            const cfg = getCfg();
            const modelKey = (this.configCenter?.get('provider.local.modelKey') as string)
              || cfg?.defaultModel || 'local';
            try {
              const info = await this.lifecycleSupervisor.startModelOnDemand(process.cwd(), modelKey);
              if (info) {
                detected = { backend: 'llamacpp', baseUrl: info.baseUrl, port: info.port ?? 8080 };
              }
            } catch { /* 启动失败 */ }
          }
        }

        if (!detected && !localCfg?.defaultModel) {
          throw new Error(
            '本地模型服务未配置。请安装 Ollama 或 llama.cpp，并确保服务正在运行。',
          );
        }

        // 检测到的优先，否则 fallback 到默认配置
        const baseUrl = detected?.baseUrl || localCfg?.baseUrl || 'http://127.0.0.1:11434/v1';
        const backend = detected?.backend || localCfg?.backend;

        // 模型名解析优先级：
        //   1. Ollama 后端 → 查询 /api/tags 获取真实模型列表，匹配配置或取第一个
        //   2. RuntimeConfigCenter 中已有的 provider.local.model（TUI /model 命令写入）
        //   3. 硬编码兜底 llama3.2
        let model: string;
        if (backend === 'ollama') {
          const { fetchOllamaModels, pickBestOllamaModel } = await import('../provider/local-config.js');
          const ollamaModels = await fetchOllamaModels();
          // 优先匹配运行时配置中的 model（TUI 切换时写入）或 localCfg 的 defaultModel
          const preferred = (this.configCenter?.get('provider.local.model') as string)
            || localCfg?.defaultModel
            || null;
          const best = pickBestOllamaModel(ollamaModels, preferred);
          if (best) {
            model = best;
          } else {
            // Ollama 在运行但没有任何模型 → 给出明确错误
            throw new Error(
              'Ollama is running but no models found. ' +
              'Run "ollama pull <model>" to download a model first.',
            );
          }
        } else {
          model = (this.configCenter?.get('provider.local.model') as string)
            || localCfg?.defaultModel
            || 'llama3.2';
        }

        try {
          newProvider = new LocalProvider({ baseUrl, model, backend });
          if (newProvider) {
            this.providerRouter.register(providerName, newProvider);
          }
        } catch {
          // fallback failed
        }
      } else {
        const created = this.tryCreateProviderFromConfig(providerName);
        if (created) {
          newProvider = created;
          this.providerRouter.register(providerName, created);
        }
      }
    }

    if (!newProvider) {
      const available = this.providerRouter.list().join(', ');
      throw new Error(
        `Provider "${providerName}" not found. Available in router: ${available}. ` +
        `Use list_providers to see all options.`,
      );
    }

    const newType = newProvider.getProviderType();
    const isLocal = newType === 'local' || newType === 'llamacpp' || newType === 'ollama';

    // 如果切换到本地模型，启动服务；如果从本地模型切走，停止服务
    if (this.lifecycleSupervisor) {
      const prevProvider = this.provider;
      const prevType = prevProvider.getProviderType();
      const prevWasLocal = prevType === 'local' || prevType === 'llamacpp' || prevType === 'ollama';

      if (isLocal && !prevWasLocal) {
        const existingBaseUrl = this.configCenter?.get('provider.local.baseUrl') as string;
        if (existingBaseUrl) {
          // 模型已通过外部（如 tui 面板 /model/local_*）启动并写入配置
        } else {
          const modelKey = this.configCenter?.get('provider.local.modelKey') as string || '';
          try {
            const modelInfo = await this.lifecycleSupervisor?.startModelOnDemand(
              process.cwd(), modelKey,
            );
            if (modelInfo && newProvider && 'setBaseUrl' in newProvider && 'setModel' in newProvider) {
              (newProvider as any).setBaseUrl(modelInfo.baseUrl);
              (newProvider as any).setModel(modelInfo.modelName);
            }
          } catch {
            // 模型启动失败，仍然尝试切换（可能服务已在外部运行）
          }
        }
      } else if (!isLocal && prevWasLocal) {
        const modelKey = this.configCenter?.get('provider.local.modelKey') as string || '';
        this.lifecycleSupervisor.stopModel(modelKey).catch(() => {});
      }

      this.previousProviderWasLocal = isLocal;
    }

    this.provider = newProvider;
    this.activeProvider = undefined;
    this.orchestrator?.setProvider(newProvider);
    this.providerRouter.setDefault(providerName);

    // 同步主通道到 ModelRouter，确保 registry 中 main 通道持有最新 Provider
    this.modelRouter?.setMainProvider(newProvider, providerName);

    // 自动裁剪上下文到新模型上限
    const modelLimit = getModelContextWindow(
      newProvider.getProviderType(),
      newProvider.getModel(),
    );

    // 1. 如果当前上下文已经超过新模型上限 → 触发压缩
    if (this.lastContextTokens > modelLimit) {
      this.maxContextTokens = modelLimit;
      this.needsCompression = true;
      if (this.configCenter) {
        // 仅内存更新，不持久化——避免覆盖用户自定义值
        this.configCenter.set('session.maxContext', modelLimit);
      }
      this.outputHandler?.onStatus?.(
        `Context (${this.lastContextTokens.toLocaleString()}) exceeds new model limit (${modelLimit.toLocaleString()}), will force compression on next turn`,
        'warn',
      );
    }
    // 2. 当前上下文没超，但 maxContextTokens 设置得比新模型上限高 → 只裁剪上限
    else if (this.maxContextTokens > modelLimit) {
      this.maxContextTokens = modelLimit;
      if (this.configCenter) {
        // 仅内存更新，不持久化——避免覆盖用户自定义值
        this.configCenter.set('session.maxContext', modelLimit);
      }
      this.outputHandler?.onStatus?.(
        `maxContextTokens updated: ${modelLimit.toLocaleString()} (model: ${newProvider.getModel()})`,
        'info',
      );
    }
    // 3. 当前上下文和新模型上限都够用 → 无需操作

    // 注意：不再在此处写 configCenter.set('provider.active') + save()，
    // 避免共享同一 RuntimeConfigCenter 单例的其他 AgentLoop 被迫切换 provider。
    // 持久化由调用方（如 TUI /model 命令）显式负责。
    this.outputHandler?.onStatus?.(
      `Provider switched to ${providerName} (${newProvider.getProviderType()}/${newProvider.getModel()})`,
      'info',
    );
    } finally {
      this.switchingProvider = false;
    }
  }

  /** 从 RuntimeConfigCenter 中的配置 + 环境变量动态创建 Provider */
  private tryCreateProviderFromConfig(providerName: string): Provider | undefined {
    if (!this.configCenter) return undefined;

    const section = this.configCenter.get(`provider.${providerName}`);
    if (!section || typeof section !== 'object') return undefined;

    const { model, apiKeyEnv, baseUrl } = section as { model?: string; apiKeyEnv?: string; baseUrl?: string };
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    const isLocal = providerName === 'local' || providerName === 'llamacpp' || providerName === 'ollama';

    if (!apiKey && !isLocal) return undefined;

    try {
      return ProviderManager.createProviderFromConfig({
        type: providerName as import('../types.js').ProviderType,
        apiKey: apiKey ?? '',
        model: model ?? '',
        baseUrl,
        userId: this.sessionDir ? mainUserId(path.basename(this.sessionDir)) : undefined,
      });
    } catch {
      return undefined;
    }
  }

  /** 订阅 RuntimeConfigCenter 变更，让 update_config 即时生效 */
  subscribeConfig(): void {
    if (!this.configCenter) return;

    // provider.active 变更 → 自动切换 provider
    this.configCenter.watch('provider.active', (event) => {
      const name = event.newValue as string;
      if (!name || typeof name !== 'string') return;
      // 守卫：如果与当前 provider 相同，跳过，避免重复切换
      const currentType = this.getActiveProvider().getProviderType();
      if (name === currentType) return;
      if (this.providerRouter?.get(name)) {
        this.switchProvider(name).catch(() => {
          this.outputHandler?.onStatus?.(`Config changed provider to "${name}" but switch failed`, 'error');
        });
      }
    });

    // provider.<name>.model 变更 → 如果当前 active provider 匹配，重新创建 provider 并切换
    this.configCenter.watch('provider.*.model', (event) => {
      const newModel = event.newValue as string;
      if (!newModel || typeof newModel !== 'string') return;
      if (!this.providerRouter || !this.configCenter) return;
      const activeName = this.configCenter.get<string>('provider.active');
      if (!activeName) return;

      // 解析路径 provider.X.model → 提取 X
      const watchPath = event.path as string;
      const parts = watchPath.split('.');
      if (parts.length < 3 || parts[0] !== 'provider' || parts[2] !== 'model') return;
      const changedProvider = parts[1];

      // 只响应当前 active provider 的 model 变更
      if (changedProvider !== activeName) return;

      // 注销旧的 provider，用新 model 重建
      this.providerRouter.unregister(activeName);
      const created = this.tryCreateProviderFromConfig(activeName);
      if (created) {
        this.providerRouter.register(activeName, created);
      }

      this.switchProvider(activeName).catch(() => {
        this.outputHandler?.onStatus?.(`Config changed model for "${activeName}" but switch failed`, 'error');
      });
    });

    // session.maxTurns 变更 → 即时更新
    this.configCenter.watch('session.maxTurns', (event) => {
      if (typeof event.newValue === 'number' && event.newValue > 0) {
        this.maxTurns = event.newValue;
        this.outputHandler?.onStatus?.(`maxTurns updated to ${event.newValue}`, 'info');
      }
    });

    // session.maxContext 变更 → 即时更新（裁剪到当前模型上限）
    this.configCenter.watch('session.maxContext', (event) => {
      if (typeof event.newValue === 'number' && event.newValue > 0) {
        const activeP = this.getActiveProvider();
        const modelLimit = getModelContextWindow(
          activeP.getProviderType(),
          activeP.getModel(),
        );
        const clamped = Math.min(event.newValue, modelLimit);
        this.maxContextTokens = clamped;
        if (clamped < event.newValue) {
          this.outputHandler?.onStatus?.(
            `maxContextTokens capped to ${clamped} (model limit: ${modelLimit})`,
            'warn',
          );
        } else {
          this.outputHandler?.onStatus?.(`maxContextTokens updated to ${clamped}`, 'info');
        }
      }
    });
  }

  /** 切换回自动路由模式 */
  switchToAutoRoute(): void {
    this.providerRouter?.clearDefault();
    this.outputHandler?.onStatus?.('Switched to auto route mode', 'info');
  }

  /** 获取 Provider 路由信息 */
  getProviderRoutingInfo(): { providerLabel: string; isLocal: boolean; mode: string } | null {
    if (!this.providerRouter) return null;
    const info = this.providerRouter.getRoutingInfo();
    return {
      providerLabel: info.providerName,
      isLocal: info.isLocal,
      mode: info.mode,
    };
  }

  setModelSource(role: ModelRole, source: 'main' | 'local'): void {
    if (!this.modelRouter || !this.configCenter) return;
    const currentModels = this.configCenter.get('models') as any;
    if (currentModels) {
      currentModels[role] = { ...currentModels[role], source };
      this.configCenter.set('models', currentModels);
      this.configCenter.save().catch(() => {});
    }
  }

  getModelSources(): Record<ModelRole, 'main' | 'local'> | null {
    if (!this.modelRouter || !this.configCenter) return null;
    const models = this.configCenter.get('models') as any;
    if (!models) return null;
    return {
      assessment: models.assessment?.source ?? 'main',
      planning: models.planning?.source ?? 'main',
      compression: models.compression?.source ?? 'main',
    };
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
   * run() 的内部实现，由串行化锁保护
   */
  private async _runInternal(userInput: string): Promise<void> {
    this.interrupted = false;
    this.abortController = new AbortController();
    // 每次用户输入重置防重复检测窗口
    this.loopGuard.reset();

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

      // 1. 将用户输入追加到 conversation（视觉模型自动检测图片路径或渠道预取图片）
      const activeP = this.getActiveProvider();
      const hasVision = activeP.getCapabilities?.()?.vision ?? false;
      let userContent: MessageContent | MessageContent[];
      if (hasVision && this.channelImages && this.channelImages.length > 0) {
        // 渠道预取图片（飞书/HTTP 等已下载为 base64）
        userContent = buildUserContentWithInlineImages(userInput, this.channelImages, this.imageStore);
        this.channelImages = null; // 一次性消费
      } else if (hasVision) {
        userContent = await buildUserContentWithImages(userInput, this.imageStore);
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
      // 不设总轮次上限 — 超长开发任务可能需要数百轮。
      // LoopGuard 跟踪连续触发次数，超过上限后强制停止以防止死循环。
      let turnCount = 0;
      let toolWasCalled = false;
      while (true) {
        if (this.interrupted) {
          this.outputHandler?.onStatus?.('Agent stopped by user.', 'info');
          break;
        }

        const result = await this.runTurn();
        turnCount++;
        if (result.toolCalled) toolWasCalled = true;

        // ── 异步子Agent 结果回合内注入 ─────────────────────────
        // delegate-tool 中异步任务完成后会将结果推送到此队列。
        // 本轮迭代结束后检查：有已完成的结果→注入对话→强制继续迭代，
        // 让 LLM 在当前 turn 内拿到结果并做出反应，无需跨 turn 手动查。
        if (this.pendingAsyncResults.length > 0) {
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
            };
            this.bypassManager.postTurn(iterCtx).catch(() => {});
          } catch { /* ignore */ }
        }

        if (result.stop) {
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
        };
        this.outputHandler?.onStatus?.('bypass-start', 'info');
        await this.bypassManager.postTurn(postCtx);
        this.outputHandler?.onStatus?.('bypass-end', 'info');
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
   * 内部方法：执行一轮 LLM 调用
   */
  private async runTurn(): Promise<{ stop: boolean; stopReason?: string; toolCalled?: boolean }> {
    this.currentTurn++;
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

    // 从 conversation 读取历史
    const history = await this.conversationStore.readAll(this.sessionDir);

    // 组装上下文 — 按当前 Router 过滤工具定义
    const ctxRouter = this.activeRouter;
    const profile = getActiveProfile();  // 保留向后兼容
    let toolDefinitions = this.toolRegistry.getToolDefinitions(ctxRouter.name === 'companion');

    // Router 指定工具白名单时，使用 Router 过滤
    if (ctxRouter.toolAllowlist.length > 0) {
      const allowed = new Set(ctxRouter.toolAllowlist);
      toolDefinitions = toolDefinitions.filter(t => allowed.has(t.name));
    } else if (this.bundleRegistry) {
      // 工具包展开：激活时触发激进压缩 + pendingBundleSummary，下轮注入 summary 段（Zone 3）
      const allowed = this.bundleRegistry.getActiveToolNames();
      if (allowed.length > 0) {
        const allowedSet = new Set(allowed);
        toolDefinitions = toolDefinitions.filter(t => allowedSet.has(t.name));
      }
    }

    // 黑名单过滤：始终生效，优先级高于白名单
    if (ctxRouter.toolBlacklist.length > 0) {
      const blocked = new Set(ctxRouter.toolBlacklist);
      toolDefinitions = toolDefinitions.filter(t => !blocked.has(t.name));
    }

    // 获取最后一条 user 消息作为 userInput
    // 排除纯 tool_result 的 user 消息（避免误删工具结果）
    const lastUserTextMsg = [...history].reverse().find(
      (m) => m.role === 'user' && hasTextContent(m.content),
    );
    let userInputText = lastUserTextMsg
      ? extractTextContent(lastUserTextMsg.content)
      : '';

    // 陪伴模式纯旁白轮：本轮 input 来自旁路 LLM 的瞬态产出（未落盘、不在 history 中），仅本轮注入
    const ephemeralUserInput = this.activeRouter.ephemeralInput ?? null;

    // 判断是否是工具执行后的续轮（history 中有 tool_use）
    const hasPendingToolCalls = history.some(
      (m) => m.role === 'assistant' && hasToolUseContent(m.content),
    );

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
    if (this.needsCompression) {
      this.outputHandler?.onStatus?.(
        `Forcing full context recompression to fit new model limit (${this.maxContextTokens.toLocaleString()})`,
        'warn',
      );
    }

    let uncompressedMsgs = history;

    let historySummary = this.currentSummary;

    // 从 history 中排除最后一条 user 文本消息（compose 会重新添加）
    // 工具执行续轮时保留在历史中供上下文参考，但不清除 userInput 以避免重复注入
    // 瞬态旁白轮：当前 input 不在 history 中，不剥离任何历史 user 消息
    const historyWithoutLastUser = hasPendingToolCalls || ephemeralUserInput
      ? history
      : lastUserTextMsg
        ? history.filter((m) => !isSameTextMessage(m, lastUserTextMsg))
        : history;

    // 续轮时清空 userInput，防止同一条用户消息被重新注入为"新输入"
    // 判断依据：历史最末尾不是用户新文本（而是 tool_result），说明是续轮
    // 如果末尾是用户文本消息（如新的"好了停吧"），则保留 userInput
    const lastMsg = history[history.length - 1];
    const hasFreshUserInput = lastMsg?.role === 'user' && hasTextContent(lastMsg.content);
    if (!hasFreshUserInput) {
      userInputText = '';
    }

    // 纯旁白轮：用旁路瞬态产出覆盖本轮 userInput，并消费一次（续轮/下一轮不再注入）
    if (ephemeralUserInput) {
      userInputText = ephemeralUserInput;
      this.activeRouter.ephemeralInput = null;
    }

    // 确定本轮实际使用的 Provider（路由决策前置，确保 compose 看到正确的 providerType）
    let activeProvider = this.provider;
    if (this.providerRouter) {
      activeProvider = this.providerRouter.route({ complexity: 'medium' });
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

    // 精确模式/陪伴模式：应用策略
    let effectiveHistory = historyWithoutLastUser;
    let effectivePersonaDir = this.personaDir;
    // Router 处理历史过滤（陪伴模式的 tool 轮次剥离等）
    effectiveHistory = hasPendingToolCalls
      ? historyWithoutLastUser
      : this.activeRouter.filterHistory(historyWithoutLastUser);
    // 精确模式（ComposeStrategy）：叠加关键词过滤 + analyzeTurn
    if (this.composeStrategy) {
      const opts = this.composeStrategy.prepareCompose(this.personaDir);
      effectivePersonaDir = opts.personaDir;
      if (this.composeStrategy.name === 'precise') {
        effectiveHistory = this.composeStrategy.filterHistory(effectiveHistory);
      }
      if (opts.preciseMode) {
        this.contextComposer.activeConditions.add('precise_mode');
      } else {
        this.contextComposer.activeConditions.delete('precise_mode');
      }
    }

    // 处理待注入图片队列（仅视觉模型）
    if (this.pendingImageInjections.length > 0 && (activeProvider.getCapabilities?.()?.vision ?? false)) {
      for (const pi of this.pendingImageInjections) {
        const imgMsg: Message = {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: pi.media_type, data: pi.data } },
            { type: 'text', text: `[Re-examining Image #${pi.imgId}]` },
          ],
        };
        await this.conversationStore.append(this.sessionDir, imgMsg);
        effectiveHistory = [...effectiveHistory, imgMsg];
      }
      this.pendingImageInjections.length = 0;
    }

    // 更新知识库检索查询（必须在 compose 之前，确保 Zone 4 读到当前轮提问）
    if (this.kbState) {
      this.kbState.lastQuery = userInputText;
    }

    // ── 旁路Agent preTurn：仅在首轮迭代运行，后续复用缓存 ───
    if (this._bypassInjections === undefined && this.bypassManager) {
      const preTurnCtx: import('../bypass/types.js').PreTurnContext = {
        userInput: userInputText,
        recentHistory: (history ?? []).slice(-20),
        contextBudget: { used: this.lastContextTokens, total: this.maxContextTokens },
        recentToolCalls: this.recentToolNames ?? [],
        sessionId: path.basename(this.sessionDir),
      };
      this.outputHandler?.onStatus?.('bypass-start', 'info');
      const preTurnResult = await this.bypassManager.preTurn(preTurnCtx);
      this.outputHandler?.onStatus?.('bypass-end', 'info');
      if (preTurnResult.transformedInput !== undefined) {
        userInputText = preTurnResult.transformedInput;
      }
      this._bypassInjections = preTurnResult.injections;
      // 消费 orchestrator 意图（用于意图簇过滤）
      if (preTurnResult.intent) {
        const cap = preTurnResult.intent.capability;
        this._currentIntent = `[${cap}] ${userInputText.slice(0, 80)}`;
        // 写入 bypass_intent 事件
        try {
          await this.eventStore.append(this.sessionDir, {
            type: 'bypass_intent',
            capability: cap,
            confidence: preTurnResult.intent.confidence,
            sessionId: path.basename(this.sessionDir),
            timestamp: new Date().toISOString(),
          });
        } catch { /* 非关键 */ }
      }
    }
    // 合并 preTurn 产出 + postTurn 运行时注入（如纠正）
    const runtimeInjections = this.bypassManager?.consumeInjections() ?? [];
    const bypassInjections = [
      ...(this._bypassInjections ?? []),
      ...runtimeInjections,
    ];
    // 运行时注入消费后即清空，不带到下一轮
    if (runtimeInjections.length > 0) {
      // 不修改 _bypassInjections，只在本轮使用合并结果
    }

    // ── 意图簇：构建历史过滤钩子 ──
    const historyTransform = await this.buildClusterHistoryTransform().catch(() => null);

    // Compose with layered options
    const layeredResult = await this.contextComposer.compose({
      sessionDir: this.sessionDir,
      providerType: activeProvider.getProviderType(),
      maxContextTokens: this.maxContextTokens,
      cwd: process.cwd(),
      timestamp: formatTimestamp(),
      tools: toolDefinitions,
      history: effectiveHistory,
      userInput: userInputText,
      historySummary,
      currentPlan: this.activePlan ? formatPlanAsText(this.activePlan) : undefined,
      zone3Hashes: undefined,
      impactInfo: this.pendingImpactInfo ?? undefined,
      fullHistory: history,
      personaDir: effectivePersonaDir,
      gitManager: this.gitManager,
      profile,
      bypassInjections,
      historyTransform,
    });
    this.pendingImpactInfo = null; // 清除已使用的影响面信息
    const messages = layeredResult.messages;
    // Flow 注入在 Zone 5（flow_injection），由 manifest 统一管理


    // 更新 current_context_tokens 到 Stats
    this.lastContextTokens = layeredResult.zoneBreakdown.total;

    // ── 压缩触发：compose 后检测 Zone 总 token 是否超过阈值 ──
    const compressThreshold = this.configCenter
      ? (this.configCenter.get('context.compressThreshold') as number) ?? 0.75
      : 0.75;
    const emergencyThreshold = this.configCenter
      ? (this.configCenter.get('context.emergencyThreshold') as number) ?? 0.92
      : 0.92;

    // Step 1: 消费上一轮的后台压缩结果
    if (this.pendingCompression) {
      const compressionResult = await this.pendingCompression;
      this.pendingCompression = null;

      if (compressionResult) {
        const compressedHistory = compressionResult.messages;
        historySummary = compressionResult.summary || this.currentSummary;

        await this.conversationStore.replace(this.sessionDir, compressedHistory);

        // 更新 uncompressedMsgs 为压缩后的消息，避免 Step 2 用旧数据再次压缩
        uncompressedMsgs = compressedHistory;

        if (compressionResult.summary) {
          this.currentSummary = compressionResult.summary;
          if (compressionResult.summary !== this.lastSavedSummary) {
            await this.summaryStore.save(this.sessionDir, compressionResult.summary);
            this.lastSavedSummary = compressionResult.summary;
          }
        }

        if (compressionResult.phasesUsed.length > 0) {
          this.compressCount++;
          await this.statsManager.increment(this.sessionDir, 'compact_count', 1);
        }

        // 重新 compose（用压缩后的 history）
        const compressedHistoryWithoutLastUser = hasPendingToolCalls
          ? compressedHistory
          : lastUserTextMsg
            ? compressedHistory.filter((m) => !isSameTextMessage(m, lastUserTextMsg))
            : compressedHistory;

        const reLayeredResult = await this.contextComposer.compose({
          sessionDir: this.sessionDir,
          providerType: activeProvider.getProviderType(),
          maxContextTokens: this.maxContextTokens,
          cwd: process.cwd(),
          timestamp: formatTimestamp(),
          tools: toolDefinitions,
          history: compressedHistoryWithoutLastUser,
          userInput: userInputText,
          historySummary,
          currentPlan: this.activePlan ? formatPlanAsText(this.activePlan) : undefined,
          zone3Hashes: undefined,
          impactInfo: this.pendingImpactInfo ?? undefined,
          fullHistory: history,
          personaDir: this.personaDir,
          gitManager: this.gitManager,
          profile,
          bypassInjections,
          historyTransform,
        });

        layeredResult.messages.length = 0;
        layeredResult.messages.push(...reLayeredResult.messages);
        layeredResult.zoneBreakdown = reLayeredResult.zoneBreakdown;

        // 更新 lastContextTokens 为压缩后的实际值
        const preCompressTokens = this.lastContextTokens;
        this.lastContextTokens = reLayeredResult.zoneBreakdown.total;

        // 输出压缩结果（使用实际 token 数）
        if (compressionResult.phasesUsed.length > 0) {
          this.outputHandler?.onStatus?.(
            `compress-result:${preCompressTokens}:${this.lastContextTokens}`,
            'info',
          );
        }

        // 激进压缩兜底检测：常规压缩后仍超标
        if (reLayeredResult.zoneBreakdown.total > this.maxContextTokens * compressThreshold) {
          if (!this.needsAggressiveCompress) {
            this.needsAggressiveCompress = true;
            this.outputHandler?.onStatus?.(
              `Compression insufficient (${reLayeredResult.zoneBreakdown.total.toLocaleString()} > ${Math.floor(this.maxContextTokens * compressThreshold).toLocaleString()}), will unprotect recent messages next turn`,
              'warn',
            );
          } else {
            this.logger.error(
              `Compressor failed to reduce context below safety threshold: ${reLayeredResult.zoneBreakdown.total}/${this.maxContextTokens}`,
            );
            this.needsAggressiveCompress = false;
            this.outputHandler?.onStatus?.(
              `Compressor failed after aggressive compression, continuing with ${reLayeredResult.zoneBreakdown.total.toLocaleString()} tokens`,
              'error',
            );
          }
        } else if (this.needsAggressiveCompress) {
          this.needsAggressiveCompress = false;
        }
      }
      // Step 1 消费完毕 → 恢复 deep 压缩临时模板
      this._maybeRestoreSummary();
    }

    // Step 2: 当前轮次超标 → 异步或同步压缩
    const currentTokens = layeredResult.zoneBreakdown.total;

    // 压缩条件：token 超阈值，或 trigger_compression 主动要求
    if (currentTokens > this.maxContextTokens * compressThreshold || this.needsCompression) {
      this.needsCompression = false;
      const zone5TailBudget = Math.floor(this.maxContextTokens * 0.15);
      const protectCount = this.needsAggressiveCompress
        ? 0
        : computeProtectCount(uncompressedMsgs, zone5TailBudget);

      // 紧急阈值：上下文接近爆满 → 同步压缩，停主对话等结果
      if (currentTokens > this.maxContextTokens * emergencyThreshold) {
        this.outputHandler?.onStatus?.(
          `⚠ Emergency: ${currentTokens.toLocaleString()} tokens (${Math.round(currentTokens / this.maxContextTokens * 100)}%) — compressing synchronously to prevent overflow`,
          'warn',
        );

        if (uncompressedMsgs && uncompressedMsgs.length > 0) {
          this.outputHandler?.onStatus?.('compress-start', 'info');
          try {
            const emergencyResult = await this.compressor.compress(
              uncompressedMsgs,
              this.currentSummary,
              0, // 不保护最近消息
              this.maxContextTokens,
              undefined,
            );

            if (emergencyResult) {
              const compressedHistory = emergencyResult.messages;
              historySummary = emergencyResult.summary || this.currentSummary;
              await this.conversationStore.replace(this.sessionDir, compressedHistory);
              uncompressedMsgs = compressedHistory;

              if (emergencyResult.summary) {
                this.currentSummary = emergencyResult.summary;
                if (emergencyResult.summary !== this.lastSavedSummary) {
                  await this.summaryStore.save(this.sessionDir, emergencyResult.summary);
                  this.lastSavedSummary = emergencyResult.summary;
                }
              }

              if (emergencyResult.phasesUsed.length > 0) {
                this.compressCount++;
                await this.statsManager.increment(this.sessionDir, 'compact_count', 1);
              }

              // 重新 compose
              const emergencyHistory = hasPendingToolCalls
                ? compressedHistory
                : lastUserTextMsg
                  ? compressedHistory.filter((m) => !isSameTextMessage(m, lastUserTextMsg))
                  : compressedHistory;

              const reLayeredResult = await this.contextComposer.compose({
                sessionDir: this.sessionDir,
                providerType: activeProvider.getProviderType(),
                maxContextTokens: this.maxContextTokens,
                cwd: process.cwd(),
                timestamp: formatTimestamp(),
                tools: toolDefinitions,
                history: emergencyHistory,
                userInput: userInputText,
                historySummary,
                currentPlan: this.activePlan ? formatPlanAsText(this.activePlan) : undefined,
                zone3Hashes: undefined,
                impactInfo: this.pendingImpactInfo ?? undefined,
                fullHistory: history,
                personaDir: this.personaDir,
                gitManager: this.gitManager,
                profile,
                bypassInjections,
              });

              layeredResult.messages.length = 0;
              layeredResult.messages.push(...reLayeredResult.messages);
              layeredResult.zoneBreakdown = reLayeredResult.zoneBreakdown;

              const preTokens = this.lastContextTokens;
              this.lastContextTokens = reLayeredResult.zoneBreakdown.total;
              this.outputHandler?.onStatus?.(
                `compress-result:${preTokens}:${this.lastContextTokens}`,
                'info',
              );
            }
          } catch (err) {
            this.logger.warn('Emergency compression failed', { error: (err as Error)?.message ?? String(err) });
          } finally {
            this.outputHandler?.onStatus?.('compress-end', 'info');
            // 紧急同步压缩完成 → 恢复 deep 压缩临时模板
            this._maybeRestoreSummary();
          }
        }
      } else {
        // 正常阈值：异步后台压缩（不阻塞 LLM 调用）
        this.outputHandler?.onStatus?.(
          `Context ${currentTokens.toLocaleString()} > ${Math.floor(this.maxContextTokens * compressThreshold).toLocaleString()} → compressing in background${this.needsAggressiveCompress ? ' (recent messages unprotected)' : ''} (protect: ${protectCount} msgs)`,
          'warn',
        );

        if (uncompressedMsgs && uncompressedMsgs.length > 0) {
          this.outputHandler?.onStatus?.('compress-start', 'info');
          this.pendingCompression = this.compressor.compress(
            uncompressedMsgs,
            this.currentSummary,
            protectCount,
            this.maxContextTokens,
            undefined,
          ).catch((err) => {
            this.logger.warn('Background compression failed', err);
            return null;
          }).finally(() => {
            this.outputHandler?.onStatus?.('compress-end', 'info');
            // 后台异步压缩完成 → 恢复 deep 压缩临时模板
            this._maybeRestoreSummary();
          });
        }
      }
    }

    await this.statsManager.update(this.sessionDir, {
      current_context_tokens: layeredResult.zoneBreakdown.total,
    });

    // 调用 provider 流式请求 LLM
    // 动态读取 thinking 配置（TUI /think 命令可运行时切换）
    const thinkingEnabled = (this.configCenter?.get('provider.enableThinking') as boolean) ?? false;
    const thinkingEffort = thinkingEnabled
      ? getModelInfo(this.provider.getProviderType(), this.provider.getModel())?.reasoningEffort
      : undefined;
    this.getActiveProvider().setThinking?.(thinkingEnabled, thinkingEffort);
    const stream = activeProvider.createStream(messages, toolDefinitions, this.abortController?.signal);

    // 使用 OutputRouter 解析流式输出
    const router = new OutputRouter();

    // 累积 assistant 回复内容
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let usageInput = 0;
    let usageOutput = 0;
    let stopReason: string | undefined;

    const oh = this.outputHandler;
    oh?.onTurnStart?.();

    router.onText = (content: string) => {
      oh?.onText?.(content);
      textParts.push(content);
      // Write event (fire-and-forget)
      appendEvent(this.sessionDir, {
        type: 'text',
        content,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    };

    router.onThinking = (content: string) => {
      oh?.onThinking?.(content);
      thinkingParts.push(content);
      appendEvent(this.sessionDir, {
        type: 'thinking',
        content,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    };

    router.onToolUse = (id: string, name: string, input: Record<string, unknown>) => {
      const inputSummary = summarizeToolInput(input);
      oh?.onToolUse?.(name, inputSummary, id);
      toolCalls.push({ id, name, input });
      appendEvent(this.sessionDir, {
        type: 'tool_call',
        id,
        name,
        input,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    };

    router.onUsage = (inputTokens: number, outputTokens: number, hit?: number, miss?: number, anthroRead?: number, anthroCreation?: number) => {
      usageInput = inputTokens;
      usageOutput = outputTokens;

      // 归一化：DeepSeek/OpenAI 用 cache_hit_tokens/cache_miss_tokens，
      // Anthropic 用 cache_read_input_tokens（命中）/ cache_creation_input_tokens（新建）。
      // 优先使用 DeepSeek 格式，否则从 Anthropic 字段推导。
      let effectiveHit: number | undefined;
      let effectiveMiss: number | undefined;

      if (hit !== undefined && miss !== undefined) {
        // DeepSeek / OpenAI 格式：直接使用
        effectiveHit = hit;
        effectiveMiss = miss;
      } else if (anthroRead !== undefined && inputTokens > 0) {
        // Anthropic 格式：cache_read 是命中量，未命中 = 总量 - 命中
        effectiveHit = anthroRead;
        effectiveMiss = Math.max(0, inputTokens - anthroRead);
      }

      if (effectiveHit !== undefined && effectiveMiss !== undefined) {
        this.cacheHitTokens = effectiveHit;
        this.cacheMissTokens = effectiveMiss;

        if (this.logCacheHits) {
          const total = effectiveHit + effectiveMiss;
          const hitRate = total > 0 ? (effectiveHit / total) * 100 : 0;

          const record: CacheTurnRecord = {
            turn: this.currentTurn,
            timestamp: new Date().toISOString(),
            inputTokens,
            outputTokens,
            hitTokens: effectiveHit,
            missTokens: effectiveMiss,
            hitRate: Math.round(hitRate * 100) / 100,
          };
          this.cacheTurns.push(record);
        }
      }
    };

    router.onStop = (reason: string) => {
      stopReason = reason;
    };

    // 消费流 (inline tool execution: dispatch tools immediately when TOOL_USE arrives)
    const inlineToolPromises: Promise<void>[] = [];

    try {
      for await (const event of stream) {
        if (this.interrupted) break;
        router.route(event);

        // Inline tool execution: execute immediately when TOOL_USE arrives in the stream
        if (event.type === 'TOOL_USE') {
          const { id, name, input } = event;
          if (id && name) {
            this.inlineToolExecuted = true;
            inlineToolPromises.push(this.executeSingleToolInline(id, name, input));
          }
        }
      }
    } catch (err) {
      const name = (err instanceof Error) ? err.name : '';
      if (name === 'AbortError' || name === 'APIUserAbortError') {
        // 用户中断，正常退出
      } else {
        throw err;
      }
    }

    // Wait for all inline tool executions to complete before proceeding
    if (inlineToolPromises.length > 0) {
      await Promise.allSettled(inlineToolPromises);
    }

    // 去重: ResilientProvider 重试流时可能累积重复的 toolCalls，
    // 保留 last-wins（成功重试的那份），清理孤儿 inlineToolResults
    if (toolCalls.length > 0) {
      const seen = new Map<string, number>();
      for (let i = 0; i < toolCalls.length; i++) {
        const key = `${toolCalls[i].name}|${JSON.stringify(toolCalls[i].input)}`;
        seen.set(key, i);
      }
      const deduped = new Set(seen.values());
      const orphanIds = new Set<string>();
      for (let i = 0; i < toolCalls.length; i++) {
        if (!deduped.has(i)) {
          orphanIds.add(toolCalls[i].id);
        }
      }
      if (orphanIds.size > 0) {
        this.logger.debug(`Deduped ${orphanIds.size} orphan tool call(s) from stream retry`);
        for (const id of orphanIds) {
          this.inlineToolResults.delete(id);
        }
        const kept = toolCalls.filter((_, i) => deduped.has(i));
        toolCalls.length = 0;
        toolCalls.push(...kept);
      }
    }

    // Scavenge: recover tool calls from thinking/text content that the model forgot to declare
    const scavengeEnabled = this.configCenter
      ? (this.configCenter.get('repair.scavenge.enabled') as boolean)
      : true;

    if (scavengeEnabled !== false && toolCalls.length === 0 && thinkingParts.length > 0) {
      const scavenged = scavengeToolCalls(thinkingParts, textParts, toolCalls);
      if (scavenged.length > toolCalls.length) {
        const newCalls = scavenged.filter(c => c.id.startsWith('scvg_'));
        this.logger.debug(`Scavenged ${newCalls.length} tool(s) from thinking: ${newCalls.map(c => c.name).join(', ')}`);
        newCalls.forEach(c => {
          this.outputHandler?.onToolUse?.(c.name, JSON.stringify(c.input).slice(0, 80), c.id);
        });
        toolCalls.length = 0;
        toolCalls.push(...scavenged);
      }
    }

    // thinking-only 模型兜底：thinking 有内容但 text 为空时，提升 thinking 为 text
    // （如 Qwen3.5 thinking 模式只输出 reasoning_content，不输出 content）
    if (textParts.length === 0 && thinkingParts.length > 0) {
      const thinkingText = thinkingParts.join('');
      textParts.push(thinkingText);
      // 通过 outputHandler 让 TUI 显示这段内容
      oh?.onText?.(thinkingText);
    }

    // 输出刷新
    if (textParts.length > 0 || thinkingParts.length > 0) {
      oh?.onFlush?.();
    }

    // 更新 stats
    const currentStats = await this.statsManager.get(this.sessionDir);
    const statsUpdate: Parameters<typeof this.statsManager.update>[1] = {
      input_tokens: currentStats.input_tokens + usageInput,
      output_tokens: currentStats.output_tokens + usageOutput,
    };
    if (this.logCacheHits) {
      statsUpdate.cache_turns = this.cacheTurns.length > 0 ? this.cacheTurns : currentStats.cache_turns;
    }
    await this.statsManager.update(this.sessionDir, statsUpdate);

    // 记录 usage 事件
    if (usageInput > 0 || usageOutput > 0) {
      await this.eventStore.append(this.sessionDir, {
        type: 'usage',
        input_tokens: usageInput,
        output_tokens: usageOutput,
        timestamp: formatTimestamp(),
      });
    }

    // 工作流完成检测在工具执行后进行（工具可能完成最后一步）

    // 异步分析本轮对话（精确模式关键词提取）
    if (this.composeStrategy && this.composeStrategy.name === 'precise') {
      const allMsgs = await this.conversationStore.readAll(this.sessionDir);
      this.composeStrategy.analyzeTurn(allMsgs, activeProvider).catch(() => {});
    }

    // 构建 assistant 消息内容
    const assistantContent: (ThinkingContent | TextContent | ToolUseContent)[] = [];

    // thinking 作为独立内容块
    if (thinkingParts.length > 0) {
      assistantContent.push({ type: 'thinking', thinking: thinkingParts.join('') });
    }

    // text 作为独立内容块
    if (textParts.length > 0) {
      assistantContent.push({ type: 'text', text: textParts.join('') });
    }

    // 添加工具调用（Flow 工具不记入历史，只记事件）
    for (const tc of toolCalls) {
      if (!isFlowTool(tc.name)) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }

      // 事件记录保留全部（含 Flow 工具），用于诊断
      await this.eventStore.append(this.sessionDir, {
        type: 'tool_call',
        tool_name: tc.name,
        tool_use_id: tc.id,
        timestamp: formatTimestamp(),
      });
    }

    // 追加 assistant 消息到 conversation
    if (assistantContent.length > 0) {
      const assistantMessage: Message = {
        role: 'assistant',
        content: assistantContent,
      };
      await this.conversationStore.append(this.sessionDir, assistantMessage);
    }

    // 如果有工具调用，执行工具并将结果追加到 conversation
    if (toolCalls.length > 0) {
      // 更新 recentToolNames 用于模式检测
      this.recentToolNames = toolCalls.map(tc => tc.name);

      // Update plan progress based on tool calls
      if (this.activePlan && toolCalls.length > 0) {
        const updatedPlan = this.orchestrator.updatePlanProgress(this.activePlan, toolCalls[0].name);
        this.activePlan = updatedPlan;
      }


      if (this.inlineToolExecuted) {
        // Tools were executed inline during the stream — flush results to conversation
        await this.flushInlineToolResults(toolCalls);
        this.inlineToolExecuted = false;
        this.inlineToolResults.clear();
      } else {
        // Fallback: execute tools after stream (for providers that don't emit TOOL_USE events mid-stream)
        await this.executeTools(toolCalls);
      }

      // ── Flow 步骤完成检测 ──
      // flow_complete 工具内部已执行 advance() + guard 检查，
      // 此处仅做 post-advance 清理（terminal → deactivate 已在工具内处理）
      if (toolCalls.some(tc => tc.name === 'flow_complete')) {
        const active = this.flowRegistry.getActive();
        if (!active) {
          // Flow 已在工具内完成并清理，无需额外处理
        }
      }

      // 工具执行完毕后，不停止，继续下一轮
      await this.checkTextLoop(textParts);
      // ── 回合回滚：回合结束记录 ──
      if (this.turnRecorder) {
        this.turnRecorder.endTurn().catch(err => {
          this.logger.warn('TurnRecorder endTurn failed', { error: (err as Error).message });
        });
      }
      return { stop: false, toolCalled: true };
    }

    // 没有 tool_calls，说明 Agent 正常结束
    await this.checkTextLoop(textParts);
    appendEvent(this.sessionDir, {
      type: 'stop',
      reason: stopReason || 'end_turn',
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    // ── 回合回滚：回合结束记录 ──
    if (this.turnRecorder) {
      this.turnRecorder.endTurn().catch(err => {
        this.logger.warn('TurnRecorder endTurn failed', { error: (err as Error).message });
      });
    }
    return { stop: true, stopReason: stopReason ?? 'end_turn' };
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

  /** Check if a bash command matches any allowedCommands glob pattern */
  private isCommandAllowed(command?: string): boolean {
    if (!command) return false;
    const trimmed = command.trim();
    for (const pattern of this.allowedCommands) {
      if (trimmed === pattern) return true;
      if (pattern.includes('*')) {
        const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (re.test(trimmed)) return true;
      }
    }
    return false;
  }

  /**
   * 内部方法：执行工具调用并写回结果
   */
  private async executeTools(toolCalls: ToolCall[]): Promise<void> {
    const permittedCalls: ToolCall[] = [];

    for (const tc of toolCalls) {
      if (this.dangerousTools.has(tc.name) && this.outputHandler?.onPermissionRequest) {
        // Step 0: AOR — unrestricted mode, skip all permissions
        if (this.unrestrictedTools) {
          permittedCalls.push(tc);
          continue;
        }
        // Step 1: check session allowlist
        if (this.allowlistTools.has(tc.name)) {
          permittedCalls.push(tc);
          continue;
        }
        // Step 2: check allowedCommands glob (bash only)
        if (tc.name === 'bash' && this.isCommandAllowed(tc.input?.command as string)) {
          permittedCalls.push(tc);
          continue;
        }
        // Step 3: pop permission
        const result = await this.outputHandler.onPermissionRequest(tc.name, tc.input);
        if (result === 'no') {
          // Permission denied — add error result directly to conversation
          const deniedMessage: Message = {
            role: 'user',
            content: {
              type: 'tool_result',
              tool_use_id: tc.id,
              content: 'Permission denied by user',
              is_error: true,
            } as ToolResultContent,
          };
          await this.conversationStore.append(this.sessionDir, deniedMessage);
          this.outputHandler?.onToolResult?.('Permission denied by user', true, tc.id);
          continue;
        }
        if (result === 'aor') {
          this.unrestrictedTools = true;
          this.outputHandler?.onStatus?.('AOR mode enabled — all future tool calls unrestricted', 'warn');
        }
        // 'yes', 'always', or 'aor' — allow this call
        if (result === 'always') {
          this.allowlistTools.add(tc.name);
          sessionAllowlist.addTool(this.sessionDir, tc.name).catch(() => {});
          if (tc.name === 'bash' && tc.input?.command) {
            sessionAllowlist.addCommand(this.sessionDir, tc.input.command as string).catch(() => {});
          }
        }
      }
      permittedCalls.push(tc);
    }

    if (permittedCalls.length === 0) return;

    // LoopGuard tool check: detect and suppress repeated identical tool calls
    const stormEnabled = this.configCenter
      ? (this.configCenter.get('repair.storm.enabled') as boolean)
      : true;

    let executableCalls: ToolCall[] = permittedCalls;

    if (stormEnabled !== false) {
      const { suppressed, reflections } = this.loopGuard.checkToolCalls(permittedCalls);
      const suppressedCalls: ToolCall[] = [];
      executableCalls = [];

      for (const tc of permittedCalls) {
        if (suppressed.has(tc.id)) {
          suppressedCalls.push(tc);
        } else {
          executableCalls.push(tc);
        }
      }

      // Inject reflection for suppressed calls
      for (const tc of suppressedCalls) {
        const reflectionText = reflections.get(tc.id) ?? ToolGuard.reflectionPrompt(tc);
        const reflectionMsg: Message = {
          role: 'user',
          content: {
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `[Storm suppressed] ${reflectionText}`,
            is_error: true,
          } as ToolResultContent,
        };
        await this.conversationStore.append(this.sessionDir, reflectionMsg);
        this.outputHandler?.onToolResult?.(`Storm suppressed: ${tc.name}`, true, tc.id);
      }
    }

    if (executableCalls.length === 0) return;

    // ── 回合回滚：记录写操作的前置状态 ──
    if (this.turnRecorder) {
      const projectDir = this.gitManager.getRepoPath();
      for (const tc of executableCalls) {
        if (['write', 'edit', 'multi_edit'].includes(tc.name)) {
          const filePath = tc.input.file_path as string;
          if (filePath) {
            this.turnRecorder.recordPreState(path.resolve(projectDir, filePath));
          }
        }
      }
    }

    // Execute permitted tools
    const results = await this.toolExecutor.executeParallel(executableCalls);

    // ── 回合回滚：记录 bash 命令 ──
    if (this.turnRecorder) {
      for (const tc of executableCalls) {
        if (tc.name === 'bash') {
          const cmd = tc.input.command as string;
          if (cmd) this.turnRecorder.recordCommand(cmd);
        }
      }
    }

    // 影响面分析：检查是否有 edit 或 write 工具被调用
    if (this.dependencyAnalyzer && permittedCalls.some(tc => tc.name === 'edit' || tc.name === 'write')) {
      const editedFiles = permittedCalls
        .filter(tc => tc.name === 'edit' || tc.name === 'write')
        .map(tc => tc.input.file_path as string)
        .filter(Boolean);
      if (editedFiles.length > 0) {
        // 先增量更新依赖图
        await this.dependencyAnalyzer.incrementalUpdate(editedFiles, this.gitManager);
        // 再查询影响面
        const impacts = editedFiles.map(f => this.dependencyAnalyzer!.getImpact(f));
        const impactLines = impacts
          .filter(i => i.allImpacts.length > 0)
          .map(i => `[Dependency Impact] ${i.sourceFile} → affects: ${i.allImpacts.join(', ')}`);
        if (impactLines.length > 0) {
          this.pendingImpactInfo = impactLines.join('\n');
        }
      }
    }

    // 将工具结果追加到 conversation（过大的结果先缓冲到磁盘）
    // 但读缓冲文件本身的结果不再二次缓冲（避免递归缓冲）
    const bufferDir = this.resultBuffer.getBufferDir();
    for (const result of results) {
      const call = executableCalls.find(c => c.id === result.tool_use_id);

      // Flow 工具结果不记入历史 — 状态由 Zone 5 注入体现
      if (call?.name && isFlowTool(call.name)) continue;

      const sanitized = sanitizeToolResult(result.content);
      const skipBuffer = call?.name === 'read' && typeof call.input.file_path === 'string' &&
        call.input.file_path.startsWith(bufferDir);
      const content = skipBuffer ? sanitized : this.resultBuffer.maybeBuffer(sanitized, result.tool_use_id);
      const toolResultMessage: Message = {
        role: 'user',
        content: {
          type: 'tool_result',
          tool_use_id: result.tool_use_id,
          content,
          is_error: result.is_error,
        } as ToolResultContent,
      };
      await this.conversationStore.append(this.sessionDir, toolResultMessage);

      // 显示工具结果摘要
      this.outputHandler?.onToolResult?.(content, result.is_error ?? false, result.tool_use_id);
      // 消费 diff 通道
      const { popDiff: popD2 } = await import('../tools/diff-channel.js');
      const diffData = popD2(result.tool_use_id);
      if (diffData) this.outputHandler?.onDiff?.(result.tool_use_id, diffData.filePath, diffData.lines);
    }

  }

  /**
   * Execute a single tool inline during the SSE stream.
   * Stores the result for later conversation append; fires onToolResult for real-time feedback.
   */
  private async executeSingleToolInline(
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const tool = this.toolRegistry.get(name);
    if (!tool) {
      const errContent = `Unknown tool: ${name}`;
      this.outputHandler?.onToolResult?.(errContent, true, id);
      this.inlineToolResults.set(id, { content: errContent, isError: true });
      appendEvent(this.sessionDir, {
        type: 'tool_result',
        tool_use_id: id,
        name,
        content: errContent,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      return;
    }

    // Permission check for dangerous tools
    if (this.dangerousTools.has(name) && this.outputHandler?.onPermissionRequest) {
      // Step 0: AOR — unrestricted mode, skip all permissions
      if (!this.unrestrictedTools) {
        // Step 1: check session allowlist
        if (this.allowlistTools.has(name)) {
          // allowed, proceed
        } else if (name === 'bash' && this.isCommandAllowed(input?.command as string)) {
          // Step 2: check allowedCommands glob
          // allowed, proceed
        } else {
          // Step 3: pop permission
          const result = await this.outputHandler.onPermissionRequest(name, input);
          if (result === 'no') {
          const deniedMsg = 'Permission denied by user';
          this.outputHandler?.onToolResult?.(deniedMsg, true, id);
          this.inlineToolResults.set(id, { content: deniedMsg, isError: true });
          appendEvent(this.sessionDir, {
            type: 'tool_result',
            tool_use_id: id,
            name,
            content: deniedMsg,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
          return;
        }
        if (result === 'aor') {
          this.unrestrictedTools = true;
          this.outputHandler?.onStatus?.('AOR mode enabled — all future tool calls unrestricted', 'warn');
        }
        if (result === 'always') {
          this.allowlistTools.add(name);
          sessionAllowlist.addTool(this.sessionDir, name).catch(() => {});
          if (name === 'bash' && input?.command) {
            sessionAllowlist.addCommand(this.sessionDir, input.command as string).catch(() => {});
          }
        }
        }
      }
    }

    // LoopGuard tool check for inline execution
    const stormEnabled = this.configCenter
      ? (this.configCenter.get('repair.storm.enabled') as boolean)
      : true;

    const STORM_EXEMPT = ['read', 'glob', 'grep'];
    if (stormEnabled !== false && !isMutating(name) && !STORM_EXEMPT.includes(name) && !isFlowTool(name)) {
      const { suppressed } = this.loopGuard.checkToolCalls([{ id, name, input }]);
      if (suppressed.has(id)) {
        const stormMsg = `[Storm suppressed] ${ToolGuard.reflectionPrompt({ id, name, input })}`;
        this.outputHandler?.onToolResult?.(stormMsg, true, id);
        this.inlineToolResults.set(id, { content: stormMsg, isError: true });
        appendEvent(this.sessionDir, {
          type: 'tool_result',
          tool_use_id: id,
          name,
          content: stormMsg,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
        return;
      }
    }

    // ── 回合回滚：记录写操作前置状态 ──
    if (this.turnRecorder) {
      if (['write', 'edit', 'multi_edit'].includes(name)) {
        const filePath = input.file_path as string;
        if (filePath) {
          this.turnRecorder.recordPreState(path.resolve(this.gitManager.getRepoPath(), filePath));
        }
      } else if (name === 'bash') {
        const cmd = input.command as string;
        if (cmd) this.turnRecorder.recordCommand(cmd);
      }
    }

    // Execute tool directly
    try {
      const rawResult = await tool.execute(input, this.abortController?.signal ?? undefined);
      // 读缓冲文件本身的结果不再二次缓冲（避免递归缓冲）
      const isBufferedRead = name === 'read' && typeof (input as Record<string, unknown>).file_path === 'string' &&
        ((input as Record<string, unknown>).file_path as string).startsWith(this.resultBuffer.getBufferDir());
      const result = isBufferedRead
        ? sanitizeToolResult(rawResult)
        : this.resultBuffer.maybeBuffer(sanitizeToolResult(rawResult), name);
      this.outputHandler?.onToolResult?.(result, false, id);
      // 消费 diff 通道（edit/write 按 filePath 写入）
      if (name === 'edit' || name === 'write' || name === 'multi_edit') {
        const { popDiff: popD } = await import('../tools/diff-channel.js');
        const fp = (input as Record<string, unknown>)?.file_path as string;
        if (fp) {
          const diffData = popD(fp);
          if (diffData) this.outputHandler?.onDiff?.(id, diffData.filePath, diffData.lines);
        }
      }
      this.inlineToolResults.set(id, { content: result, isError: false });
      appendEvent(this.sessionDir, {
        type: 'tool_result',
        tool_use_id: id,
        name,
        content: result.slice(0, 1000), // truncate long results in events log
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.outputHandler?.onToolResult?.(`Error: ${errMsg}`, true, id);
      this.inlineToolResults.set(id, { content: `Error: ${errMsg}`, isError: true });
      appendEvent(this.sessionDir, {
        type: 'tool_result',
        tool_use_id: id,
        name,
        content: `Error: ${errMsg}`,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  /**
   * Flush inline tool results to the conversation store and run dependency analysis.
   * Called after the assistant message has been appended to maintain correct message ordering.
   */
  private async flushInlineToolResults(toolCalls: ToolCall[]): Promise<void> {
    // Dependency impact analysis (same logic as executeTools)
    if (this.dependencyAnalyzer && toolCalls.some(tc => tc.name === 'edit' || tc.name === 'write')) {
      const editedFiles = toolCalls
        .filter(tc => tc.name === 'edit' || tc.name === 'write')
        .map(tc => tc.input.file_path as string)
        .filter(Boolean);
      if (editedFiles.length > 0) {
        await this.dependencyAnalyzer.incrementalUpdate(editedFiles, this.gitManager);
        const impacts = editedFiles.map(f => this.dependencyAnalyzer!.getImpact(f));
        const impactLines = impacts
          .filter(i => i.allImpacts.length > 0)
          .map(i => `[Dependency Impact] ${i.sourceFile} -> affects: ${i.allImpacts.join(', ')}`);
        if (impactLines.length > 0) {
          this.pendingImpactInfo = impactLines.join('\n');
        }
      }
    }

    // Append stored inline results to conversation
    for (const tc of toolCalls) {
      // Flow 工具结果不记入历史 — 状态由 Zone 5 注入体现
      if (isFlowTool(tc.name)) continue;

      const stored = this.inlineToolResults.get(tc.id);
      if (!stored) {
        // Tool wasn't executed inline (e.g., filtered out) — skip
        continue;
      }
      const toolResultMessage: Message = {
        role: 'user',
        content: {
          type: 'tool_result',
          tool_use_id: tc.id,
          content: stored.content,
          is_error: stored.isError,
        } as ToolResultContent,
      };
      await this.conversationStore.append(this.sessionDir, toolResultMessage);
    }

  }

  /**
   * 回收已处理图片：将非最后一轮的 image base64 替换为占位符。
   *
   * - 保留最后一条 user 消息中的图片（模型当前轮还在看）
   * - 更早的图片 → 用模型后续的回复作为描述，替换为纯文本占位符
   * - 无模型描述时 → 用元信息占位符
   * - 替换后的占位符包含 img_id，模型可通过 view_image 重新查看
   */
  async recycleProcessedImages(): Promise<void> {
    try {
      const history = await this.conversationStore.readAll(this.sessionDir);
      if (history.length === 0) return;

      // 找到最后一条真正的 user 消息（跳过 tool_result，它们 role 也是 user）
      let lastUserIdx = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i]!;
        if (m.role === 'user') {
          const items = Array.isArray(m.content) ? m.content : [m.content];
          // 跳过纯 tool_result 消息
          if (items.every(c => c.type === 'tool_result')) continue;
          lastUserIdx = i; break;
        }
      }
      if (lastUserIdx < 0) return;

      let modified = false;
      const cleaned = history.map((msg, idx) => {
        // 保留最后一条 user 消息中的图片
        if (idx === lastUserIdx) return msg;

        const items = Array.isArray(msg.content) ? msg.content : [msg.content];
        let changed = false;
        const newItems = items.map((item, itemIdx) => {
          if (item.type !== 'image') return item;
          changed = true;
          modified = true;

          // 1) 从相邻 text 块提取 img_id
          let imgId = '';
          if (itemIdx + 1 < items.length && items[itemIdx + 1]!.type === 'text') {
            const m = (items[itemIdx + 1] as any).text.match(/\[Image indexed as #(img_\d{3})/);
            if (m) imgId = m[1];
          }
          if (!imgId) {
            for (const ti of items) {
              if (ti.type !== 'text') continue;
              const m = (ti as any).text.match(/\[Image indexed as #(img_\d{3})/);
              if (m) { imgId = m[1]; break; }
            }
          }
          // 无已有索引 → 存入 ImageStore
          const src = item.source as { type: string; media_type?: string; data?: string; url?: string };
          if (!imgId && src.type === 'base64' && src.data) {
            imgId = this.imageStore.store(
              src.data, src.media_type || 'image/png', '',
            );
          }

          // 2) 从后续 assistant 回复中提取模型对图片的描述
          let description = '';
          for (let j = idx + 1; j < Math.min(history.length, idx + 4); j++) {
            const nextMsg = history[j];
            if (nextMsg?.role !== 'assistant') continue;
            const nextItems = Array.isArray(nextMsg.content) ? nextMsg.content : [nextMsg.content];
            for (const ni of nextItems) {
              if (ni.type === 'text' && ni.text.trim().length > 10) {
                description = ni.text.replace(/^#{1,4}\s+/gm, '').trim().slice(0, 250);
                break;
              }
            }
            if (description) break;
          }

          // 3) 回存描述到 ImageStore
          if (description && imgId) {
            this.imageStore.setDescription(imgId, description);
          }

          // 4) 返回占位符
          if (description) {
            return { type: 'text' as const, text: `[Image #${imgId}: ${description} — view_image("${imgId}") to re-examine]` };
          }
          // fallback: 元信息
          const mime = src.media_type || 'image/unknown';
          const ext = mime.split('/')[1] || 'unknown';
          const decodedBytes = src.data ? Math.ceil(src.data.length * 0.75) : 0;
          const sizeStr = decodedBytes < 1024 ? `${decodedBytes}B` : `${(decodedBytes / 1024).toFixed(1)}KB`;
          return { type: 'text' as const, text: `[Image #${imgId || '?'}: ${ext.toUpperCase()}, ${sizeStr} — view_image("${imgId || '?'}") to re-examine]` };
        });

        if (!changed) return msg;
        // 过滤冗余的 [Image indexed as #...] 文本块
        const filtered = newItems.filter(it => {
          if (it.type === 'text' && /^\[Image indexed as #img_\d{3}:/.test((it as any).text)) return false;
          return true;
        });
        return { ...msg, content: filtered.length === 1 ? filtered[0] : filtered };
      });

      if (modified) {
        await this.conversationStore.replace(this.sessionDir, cleaned);
      }
    } catch {
      // 回收失败不影响主流程
    }
  }

  /** 释放资源：停路由器（含 WorldEngine）+ 停调度器 */
  async shutdown(): Promise<void> {
    await this.activeRouter.onDeactivate?.(this).catch(() => {});
    await this.scheduler?.stop();
  }

  // ── 意图簇：分簇压缩 ──────────────────────────────────────


  // ── deep 压缩模板恢复 ────────────────────────────────────────

  /** 恢复被 trigger_compression(level=deep) 临时替换的 summary.md */
  private _maybeRestoreSummary(): void {
    if (!this._deepCompressRestore) return;
    this._deepCompressRestore = false;
    const summaryPath = path.join(os.homedir(), '.agent', 'prompts', 'summary.md');
    try {
      if (this._deepCompressOriginal !== null) {
        fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
        fs.writeFileSync(summaryPath, this._deepCompressOriginal, 'utf-8');
      } else {
        // 原本没有自定义模板 → 删除临时文件，回退到内置默认
        try { fs.unlinkSync(summaryPath); } catch {}
      }
    } catch {
      // 恢复失败不阻塞主流程
    }
    this._deepCompressOriginal = null;
  }

  /**
   * 检查指定簇是否超限，超限则从全量存档提取消息并压缩。
   * 压缩结果存入 summaries/cluster_X.md。
   * 触发阈值沿用现有全局压缩阈值（context.compressThreshold），不为簇独立设计。
   */
  private async maybeCompressCluster(
    clusterId: string,
    lineStart: number,
    lineEnd: number,
    capability: string,
  ): Promise<void> {
    try {
      const fullMsgs = await this.conversationStore.readFull(this.sessionDir);
      const clusterMsgs = fullMsgs.slice(lineStart - 1, lineEnd); // 行号从 1 开始
      if (clusterMsgs.length === 0) return;

      const tokenCount = this.compressor
        ? this.compressor.getCompressionStats(clusterMsgs).totalTokens
        : clusterMsgs.length * 50; // 回退估算

      // 沿用全局压缩阈值（与主流程一致），预算 = 总上限 × 全局阈值
      const compressThreshold = this.configCenter
        ? (this.configCenter.get('context.compressThreshold') as number) ?? 0.75
        : 0.75;
      const budget = this.maxContextTokens * compressThreshold;
      if (tokenCount < budget) return;

      if (!this.compressor) {
        this.logger?.info?.(`[cluster] compress skipped for ${clusterId}: no compressor available`);
        return;
      }

      this.logger?.info?.(
        `[cluster] compressing cluster "${clusterId}" (${capability}): ` +
        `${clusterMsgs.length} msgs, ${tokenCount} tokens > ${budget} budget`,
      );

      // 加载已有簇摘要做增量压缩
      const existingSummary = await this.summaryStore.load(this.sessionDir, clusterId);
      const result = await this.compressor.compress(
        clusterMsgs,
        existingSummary ?? undefined,
        0,         // protectLast = 0（簇内不加保护）
        budget,
        // 方案 3.5：指定 clusterKey 按簇压缩——预算 ×0.7、摘要入 clusterSummaries 分桶、收集 compressedMessages
        { clusterKey: capability },
      );

      if (result.summary) {
        // 簇级摘要（cluster_{clusterId}.md）——factory 读取端依赖此路径（Step 4 对齐）
        await this.summaryStore.save(this.sessionDir, result.summary, clusterId);
        // 方案 G：capability 分桶（summary.{capability}.md），渐进式新增包装层
        try {
          await this.compressor.saveClusterSummary(this.sessionDir, capability);
        } catch { /* 分桶写入失败不阻塞 */ }
        // 决策 C：被压缩消息写回 _compressed 标记（仅保留最近一次压缩记录，覆盖而非追加）
        if (result.compressedCount && result.compressedCount > 0) {
          const marker = result.compressedMessages?.[0]?._compressed ?? {
            intent: capability,
            summary_hash: '',
            compressed_at: new Date().toISOString(),
          };
          await this.conversationStore.markCompressed(
            this.sessionDir,
            lineStart,
            result.compressedCount,
            marker,
          );
        }
        this.logger?.info?.(
          `[cluster] compressed "${clusterId}" (${capability}): ${result.compressedCount ?? 0} msgs → summary saved + _compressed marked`,
        );
      }
    } catch (err) {
      this.logger?.warn?.(
        `[cluster] compress failed for "${clusterId}": ${(err as Error).message}`,
      );
    }
  }

  // ── 意图簇：Composer 过滤钩子 ─────────────────────────────

  /**
   * 构建 historyTransform 函数供 Composer 使用。
   * 启用条件：conversation_full.jsonl 文件大小 > 5MB 且存在匹配当前意图的簇。
   * 过滤基于全量归档（conversation_full.jsonl，含 _cluster_id 标记）：
   *   保留「当前意图簇的消息 + 最近 N 轮保底」，其余丢弃。
   * 未启用时返回 null（全量注入，和现在一样）。
   */
  private async buildClusterHistoryTransform(): Promise<((msgs: Message[]) => Message[]) | null> {
    // 阈值检查
    try {
      const fullPath = path.join(this.sessionDir, 'conversation_full.jsonl');
      const stat = await fs.promises.stat(fullPath);
      if (stat.size < 5 * 1024 * 1024) return null; // < 5MB，不过滤
    } catch {
      return null; // 文件不存在
    }

    // 读取簇索引（从 events.jsonl 回放）
    const clusters = await this.loadClusterIndex();
    if (clusters.length === 0) return null;

    const currentCapability = this.getCurrentIntentCapability();
    // 当前意图对应的簇 ID 集合（capability 匹配）
    const targetClusterIds = new Set(
      clusters.filter((c) => c.capability === currentCapability).map((c) => c.cluster_id),
    );
    if (targetClusterIds.size === 0) {
      this.logger?.info?.(
        `[cluster] filter skipped: capability=${currentCapability} 无匹配簇，回退全量注入`,
      );
      return null;
    }

    const recentCount = 10; // 最近 N 轮保底（与压缩器 protect 量级一致）

    this.logger?.info?.(
      `[cluster] filter enabled: capability=${currentCapability}, ` +
      `targetClusters=${[...targetClusterIds].join(',')}, ` +
      `recent=${recentCount}`,
    );

    // 预取全量归档并预筛（全量归档含 _cluster_id 标记，conversation.jsonl 没有）
    // 闭包内同步返回，避免 composer 的同步 historyTransform 阻塞。
    const fullMsgs = await this.conversationStore.readFull(this.sessionDir);
    if (fullMsgs.length === 0) return null;
    const recentMsgs = fullMsgs.slice(-recentCount);
    const olderMsgs = fullMsgs.slice(0, -recentCount);
    const keptOlder = olderMsgs.filter(
      (m) => m._cluster_id && targetClusterIds.has(m._cluster_id),
    );
    const filteredFull = [...keptOlder, ...recentMsgs];

    return (_msgs: Message[]): Message[] => {
      // 若过滤结果为空，回退调用方传入的历史（防御）
      if (filteredFull.length === 0) return _msgs;
      // 全量归档远大于 conversation 历史时（压缩已发生），以 conversation 为准
      // 避免压缩后的精简历史被全量原始消息绕过
      if (filteredFull.length > _msgs.length * 3) return _msgs;
      return filteredFull;
    };
  }

  /**
   * 从 events.jsonl 回放 cluster_assign 事件，重建簇索引。
   */
  private async loadClusterIndex(): Promise<Array<{
    cluster_id: string; capability: string; summary: string;
    line_start: number; line_end: number;
  }>> {
    try {
      const events = await this.eventStore.readAll(this.sessionDir);
      const clusters: Array<{
        cluster_id: string; capability: string; summary: string;
        line_start: number; line_end: number;
      }> = [];
      for (const evt of events) {
        if (evt.type === 'cluster_assign') {
          clusters.push({
            cluster_id: evt.cluster_id as string,
            capability: evt.capability as string,
            summary: evt.summary as string,
            line_start: evt.line_start as number,
            line_end: evt.line_end as number,
          });
        }
      }
      return clusters;
    } catch {
      return [];
    }
  }

}

/**
 * 判断消息是否包含文本内容（而非纯 tool_result）
 */
function hasTextContent(content: Message['content']): boolean {
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    return content.some((c) => c.type === 'text');
  }
  return content.type === 'text';
}

/**
 * 判断消息是否包含 tool_use 内容
 */
function hasToolUseContent(content: Message['content']): boolean {
  if (typeof content === 'string') return false;
  if (Array.isArray(content)) {
    return content.some((c) => c.type === 'tool_use');
  }
  return content.type === 'tool_use';
}

/**
 * 生成工具输入的摘要字符串
 */
function summarizeToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '{}';

  const parts = entries.map(([key, value]) => {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    const truncated = str.length > 80 ? str.slice(0, 77) + '...' : str;
    return `${key}=${truncated}`;
  });

  return parts.join(', ');
}
