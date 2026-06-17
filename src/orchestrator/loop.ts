import type { Provider } from '../provider/interface.js';
import type { ProviderRouter } from '../provider/router.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { ModelRole } from '../provider/model-router.js';
import { ProviderManager } from '../provider/manager.js';
import { LocalProvider } from '../provider/local.js';
import { LayeredContextComposer } from '../context/composer.js';
import { CompressorOrchestrator, type CompressionResult } from '../context/compressor.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConversationStore } from '../memory/conversation.js';
import { readCompressionBoundary, writeCompressionBoundary } from '../memory/compression-boundary.js';
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
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ImageStore, buildUserContentWithImages, buildUserContentWithInlineImages, createViewImageTool } from '../multimodal/index.js';
import { createLogger } from '../logging/logger.js';
import { getBootstrapStatus, markBootstrapComplete } from '../setup/persona-bootstrap.js';
import { HeartbeatScheduler } from '../schedule/scheduler.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../setup/config.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import type { SafetyConfig } from '../setup/config.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { LoopGuard, isMutating, ToolGuard } from '../repair/loop-guard.js';
import { scavengeToolCalls } from '../repair/scavenge.js';
import { ToolResultBuffer } from '../tools/result-buffer.js';
import { sanitizeToolResult } from '../tools/injection-filter.js';
import type { ComposeStrategy } from '../context/precision/index.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { GitManager } from '../evolution/git-manager.js';
import { extractTextContent } from '../utils/misc.js';
import type { WorkflowManager } from '../workflow/index.js';
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
  /** Request user permission for dangerous tool execution. Returns 'yes' (once), 'no' (deny), or 'always' (add to allowlist). */
  onPermissionRequest?(toolName: string, input: Record<string, unknown>): Promise<'yes' | 'no' | 'always'>;
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
    // @ts-expect-error — sharp 0.35 的 types 与 pnpm exports 解析不兼容
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
  private lastSavedSummary: string | undefined;
  private pendingImpactInfo: string | null = null;
  private requestId: string;
  private logger: ReturnType<typeof createLogger>;
  private bootstrapStatus: 'pending' | 'complete';
  private activeProvider?: Provider;
  private scheduler: HeartbeatScheduler | null = null;
  private schedulerInitialized = false;
  /** 定时任务触发后待注入对话的通知 */
  pendingTaskNotifications: Array<{ name: string; firedAt: string }> = [];
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
  /** 上下文组装策略（精确模式切换用） */
  composeStrategy: ComposeStrategy | null = null;
  /** Whether any tools were executed inline during the current stream */
  private inlineToolExecuted = false;
  /** Stores results from inline tool execution, keyed by tool_use_id */
  private inlineToolResults: Map<string, { content: string; isError: boolean }> = new Map();
  /** Tools that require user confirmation before execution */
  private dangerousTools: Set<string>;
  /** Tools whitelisted by user (skip confirmation — session-level, from 'always' response) */
  private allowlistTools: Set<string>;
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
  private needsCompression = false;
  private pendingCompression: Promise<CompressionResult | null> | null = null;
  /** 工具触发的临时策略覆盖，仅在下一轮压缩时生效，用后即清 */
  pendingCompressionStrategy: string | null = null;
  private lifecycleSupervisor: LifecycleSupervisor | null = null;
  private previousProviderWasLocal = false;

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
    bootstrapStatus?: 'pending' | 'complete',
    private providerRouter?: ProviderRouter,
    dangerousTools?: Set<string>,
    allowlistTools?: Set<string>,
    configCenter?: RuntimeConfigCenter,
    private workflowManager?: WorkflowManager,
    private modelRouter?: ModelRouter,
  ) {
    this.orchestrator = orchestrator;
    this.outputHandler = outputHandler ?? null;
    this.agentRegistry = agentRegistry;
    this.bootstrapStatus = bootstrapStatus ?? 'complete';
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

      // Restore thinking mode
      const persistedThinking = this.configCenter.get('provider.enableThinking') as boolean | undefined;
      if (typeof persistedThinking === 'boolean') {
        this.provider.setThinking?.(persistedThinking);
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

      // Subscribe to thinking mode changes
      this.configCenter.watch('provider.enableThinking', (event) => {
        const enabled = event.newValue as boolean;
        this.getActiveProvider().setThinking?.(enabled);
        this.outputHandler?.onStatus?.(
          `Thinking mode ${enabled ? 'enabled' : 'disabled'}`,
          'info',
        );
      });
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

  /** 是否为 bootstrap 引导模式 */
  isBootstrapPending(): boolean {
    return this.bootstrapStatus === 'pending';
  }

  /** 就地切换到指定 session，无需重启进程 */
  async switchSession(newSessionDir: string): Promise<void> {
    // 1. 保存当前 session 的状态
    this.workflowManager?.switchSession(newSessionDir);

    this.sessionDir = newSessionDir;
    this.currentSummary = undefined;
    this.compressCount = 0;
    this.needsAggressiveCompress = false;
    this.inlineToolResults.clear();
    this.pendingImpactInfo = null;
    this.pendingTaskNotifications = [];
    this.pendingCompression = null;
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
          const modelKey = this.configCenter?.get('provider.local.modelKey') as string ?? 'qwen';
          this.lifecycleSupervisor.stopModel(modelKey).catch(() => {});
        }
        this.previousProviderWasLocal = false;
      } else if (!info.isLocal && localProviders.length > 0) {
        this.providerRouter.setDefault(localProviders[0]);
        if (this.lifecycleSupervisor) {
          const existingBaseUrl = this.configCenter?.get('provider.local.baseUrl') as string;
          if (!existingBaseUrl) {
            const modelKey = this.configCenter?.get('provider.local.modelKey') as string ?? 'qwen';
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

        // 检测到的优先，否则 fallback 到 local-provider.json
        const baseUrl = detected?.baseUrl || localCfg?.baseUrl || 'http://127.0.0.1:11434/v1';
        const backend = detected?.backend || localCfg?.backend;
        const model = localCfg?.defaultModel || 'llama3.2';

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
          const modelKey = this.configCenter?.get('provider.local.modelKey') as string ?? 'qwen';
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
        const modelKey = this.configCenter?.get('provider.local.modelKey') as string ?? 'qwen';
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

    if (this.configCenter) {
      this.configCenter.set('provider.active', providerName);
      this.configCenter.save().catch(() => {});
    }
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
      if (name && typeof name === 'string' && this.providerRouter?.get(name)) {
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
    const prompt = `[Scheduled Task Triggered]\nYour scheduled task "${taskName}" has just been triggered. Execute it now. If this was a one-shot task, it has completed — no need to reschedule.`;
    await this.run(prompt);
  }

  /** 启动 bootstrap 引导：用空消息触发 AI 主动对话 */
  async startBootstrap(): Promise<void> {
    if (this.bootstrapStatus !== 'pending') return;
    this.outputHandler?.onStatus?.('Starting bootstrap initialization...', 'info');
    await this.run('');
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
      // Load persisted summary if available
      if (!this.currentSummary) {
        const persisted = await this.summaryStore.load(this.sessionDir);
        if (persisted) {
          this.currentSummary = persisted;
        }
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
      await this.conversationStore.append(this.sessionDir, userMessage);

      // 记录用户输入事件
      await this.eventStore.append(this.sessionDir, {
        type: 'user_input',
        content: userInput,
        timestamp: formatTimestamp(),
      });

      // 2. 主循环：compose -> LLM -> parse -> tool -> compose
      // 不设总轮次上限 — 超长开发任务可能需要数百轮。
      // LoopGuard 跟踪连续触发次数，超过上限后强制停止以防止死循环。
      let turnCount = 0;
      while (true) {
        if (this.interrupted) {
          this.outputHandler?.onStatus?.('Agent stopped by user.', 'info');
          break;
        }

        const result = await this.runTurn();
        turnCount++;

        // 更新 stats
        await this.statsManager.increment(this.sessionDir, 'turn_count', 1);

        // Bootstrap 完成检测：每轮结束后检查 BOOTSTRAP.md 是否已被删除
        if (this.bootstrapStatus === 'pending' && this.personaDir) {
          const status = await getBootstrapStatus(this.personaDir);
          if (status === 'complete') {
            this.bootstrapStatus = 'complete';
            await markBootstrapComplete(this.personaDir);
            this.outputHandler?.onStatus?.('Bootstrap initialization complete.', 'info');
          }
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

      // 每轮结束后回收已处理图片：旧 base64 → 占位符 + 模型描述
      if (!this.interrupted) {
        this.recycleProcessedImages().catch(() => {});
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputHandler?.onStatus?.(
        `Provider error: ${message}`,
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
  private async runTurn(): Promise<{ stop: boolean; stopReason?: string }> {
    this.currentTurn++;
    // 从 conversation 读取历史
    const history = await this.conversationStore.readAll(this.sessionDir);

    // 组装上下文 — 按当前激活的工具包过滤工具定义
    let toolDefinitions = this.toolRegistry.getToolDefinitions();
    // 工具包展开：激活时触发激进压缩 + pendingBundleSummary，下轮注入 summary 段（Zone 3）
    // 后续轮次不重复注入（pendingBundleSummary 为 null 时不追加）
    if (this.bundleRegistry) {
      const allowed = this.bundleRegistry.getActiveToolNames();
      if (allowed.length > 0) {
        const allowedSet = new Set(allowed);
        toolDefinitions = toolDefinitions.filter(t => allowedSet.has(t.name));
      }
    }

    // 获取最后一条 user 消息作为 userInput
    // 排除纯 tool_result 的 user 消息（避免误删工具结果）
    const lastUserTextMsg = [...history].reverse().find(
      (m) => m.role === 'user' && hasTextContent(m.content),
    );
    let userInputText = lastUserTextMsg
      ? extractTextContent(lastUserTextMsg.content)
      : '';

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

    // ── 增量压缩：通过 compression-boundary 追踪已压缩消息数，只压缩新消息 ──
    const sessionId = path.basename(this.sessionDir);

    // 切换到大窗口→小窗口模型后，强制全量重压缩
    if (this.needsCompression) {
      this.needsCompression = false;
      // 重置压缩边界，让所有消息参与压缩
      await writeCompressionBoundary(sessionId, {
        compressedCount: 0,
        lastCompactTurn: this.currentTurn,
      });
      this.outputHandler?.onStatus?.(
        `Forcing full context recompression to fit new model limit (${this.maxContextTokens.toLocaleString()})`,
        'warn',
      );
    }

    const boundary = await readCompressionBoundary(sessionId, history.length);

    // 分离已压缩/未压缩消息
    let uncompressedMsgs = history.slice(boundary.compressedCount);

    let historySummary = this.currentSummary;

    // 从 history 中排除最后一条 user 文本消息（compose 会重新添加）
    // 工具执行续轮时保留在历史中供上下文参考，但不清除 userInput 以避免重复注入
    const historyWithoutLastUser = hasPendingToolCalls
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

    // 精确模式：应用策略
    let effectiveHistory = historyWithoutLastUser;
    let effectivePersonaDir = this.personaDir;
    if (this.composeStrategy) {
      const opts = this.composeStrategy.prepareCompose(this.personaDir);
      effectivePersonaDir = opts.personaDir;
      effectiveHistory = this.composeStrategy.filterHistory(historyWithoutLastUser);
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
      bootstrapStatus: this.bootstrapStatus,
      gitManager: this.gitManager,
    });
    this.pendingImpactInfo = null; // 清除已使用的影响面信息
    const messages = layeredResult.messages;
    // 工作流注入在 Zone 5（workflow-persistent / workflow-step），由 manifest 统一管理


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

        // 先更新 boundary，再替换文件（防御性顺序）
        // 如果 boundary 写成功但 replace 失败 → 下一轮用旧数据重新压缩（安全）
        // 如果先 replace 再 boundary，replace 成功但 boundary 失败 → 下一轮可能重复压缩（也安全但浪费）
        // 两者都安全，但先 boundary 的后果更轻
        await writeCompressionBoundary(sessionId, {
          compressedCount: 0,
          lastCompactTurn: this.currentTurn,
        });
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

        const llmCompressedCount = compressionResult.phasesUsed.some(p => p === 2 || p === 3)
          ? uncompressedMsgs.length
          : 0;
        if (llmCompressedCount > 0) {
          await writeCompressionBoundary(sessionId, {
            compressedCount: boundary.compressedCount + llmCompressedCount,
            lastCompactTurn: this.currentTurn,
          });
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
          bootstrapStatus: this.bootstrapStatus,
          gitManager: this.gitManager,
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
    }

    // Step 2: 当前轮次超标 → 异步或同步压缩
    const currentTokens = layeredResult.zoneBreakdown.total;

    // LLM 摘要模式：工具临时覆盖优先 → 否则从 config 读取
    // 提前消费：手动触发（trigger_compression）不受阈值门限制
    // _default sentinel 表示使用 config 默认策略，但仍触发压缩
    const toolOverrideRaw = this.pendingCompressionStrategy;
    this.pendingCompressionStrategy = null; // 用后即清
    const toolOverride = (toolOverrideRaw && toolOverrideRaw !== '_default') ? toolOverrideRaw : null;
    const strategySource = toolOverride
      ?? (this.configCenter
        ? (this.configCenter.get('context.compressionStrategy') as string) ?? 'C'
        : 'C');

    // 压缩条件：token 超阈值，或模型通过 trigger_compression 主动要求
    if (currentTokens > this.maxContextTokens * compressThreshold || toolOverrideRaw !== null) {
      const llmMode: 'prompt' | 'clone' = strategySource === 'C' ? 'clone' : 'prompt';
      const compressOptions = {
        llmMode,
        composedMessages: llmMode === 'clone' ? layeredResult.messages : undefined,
      };

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
              compressOptions,
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
                bootstrapStatus: this.bootstrapStatus,
                gitManager: this.gitManager,
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
            compressOptions,
          ).catch((err) => {
            this.logger.warn('Background compression failed', err);
            return null;
          }).finally(() => {
            this.outputHandler?.onStatus?.('compress-end', 'info');
          });
        }
      }
    }

    await this.statsManager.update(this.sessionDir, {
      current_context_tokens: layeredResult.zoneBreakdown.total,
    });

    // 调用 provider 流式请求 LLM
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

    // 添加工具调用（workflow 管理操作不记入历史，只记事件）
    for (const tc of toolCalls) {
      if (tc.name !== 'workflow') {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }

      // 事件记录保留全部（含 workflow），用于诊断
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
      // 工具执行前保存工作流状态快照，用于检测完成
      const hadActiveWorkflow = this.workflowManager?.isActive() ?? false;
      const activeWorkflowName = hadActiveWorkflow ? this.workflowManager?.getActive() ?? null : null;
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

      // 工具执行完毕后，检测工作流是否被完成
      if (hadActiveWorkflow && activeWorkflowName && !(this.workflowManager?.isActive() ?? false)) {
        // 工作流刚被 workfow tool 在工具执行中完成（调用了 deactivate）
        const completedMsg: Message = {
          role: 'user',
          content: { type: 'text', text: `[System] Workflow "${activeWorkflowName}" completed. All steps finished.` },
        };
        await this.conversationStore.append(this.sessionDir, completedMsg);
        this.outputHandler?.onStatus?.(`Workflow "${activeWorkflowName}" completed`, 'info');
        await this.checkTextLoop(textParts);
        // 工作流已完成，跳过额外 API 调用，直接结束
        appendEvent(this.sessionDir, {
          type: 'stop',
          reason: 'workflow_completed',
          timestamp: new Date().toISOString(),
        }).catch(() => {});
        return { stop: true, stopReason: 'workflow_completed' };
      }

      // 工具执行完毕后，不停止，继续下一轮
      await this.checkTextLoop(textParts);
      return { stop: false };
    }

    // 没有 tool_calls，说明 Agent 正常结束
    await this.checkTextLoop(textParts);
    appendEvent(this.sessionDir, {
      type: 'stop',
      reason: stopReason || 'end_turn',
      timestamp: new Date().toISOString(),
    }).catch(() => {});
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
        // 'yes' or 'always' — allow this call
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

    // Execute permitted tools
    const results = await this.toolExecutor.executeParallel(executableCalls);

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

      // workflow 工具结果不记入历史 — 状态由 Zone 5 注入体现
      if (call?.name === 'workflow') continue;

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
      if (result === 'always') {
        this.allowlistTools.add(name);
        sessionAllowlist.addTool(this.sessionDir, name).catch(() => {});
        if (name === 'bash' && input?.command) {
          sessionAllowlist.addCommand(this.sessionDir, input.command as string).catch(() => {});
        }
      }
      }
    }

    // LoopGuard tool check for inline execution
    const stormEnabled = this.configCenter
      ? (this.configCenter.get('repair.storm.enabled') as boolean)
      : true;

    const STORM_EXEMPT = ['read', 'glob', 'grep', 'workflow'];
    if (stormEnabled !== false && !isMutating(name) && !STORM_EXEMPT.includes(name)) {
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
      // workflow 工具结果不记入历史 — 状态由 Zone 5 注入体现
      if (tc.name === 'workflow') continue;

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

  /** 释放资源，停止调度器 */
  async dispose(): Promise<void> {
    await this.scheduler?.stop();
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
