// ============================================================
// LayeredContextComposer — 上下文组装器（7 机制之一）
// ============================================================
//
// 职责：filterHistory — 消息过滤
//
// 将 manifest 定义的 section 按 Zone 分层组装为最终发送给 LLM 的
// 消息数组。内置缓存策略（按 provider 类型适配断点/前缀缓存）和
// 历史消息过滤（跳过 system 消息、纯 thinking 块、系统注入文本）。
//
// 与 Manifest 的关系：
//   Manifest（菜单）定义"有什么" — section 列表、zone 归属、类型。
//   Composer（厨师）负责"怎么拼" — 读取 manifest → 按 zone 遍历 section
//     → 调 SectionResolver 解析内容 → 按 role 合并 → 输出 Message[]。
//   要新增一个上下文 section，只改 Manifest；要改组装逻辑，只改 Composer。
//
// 7 种上下文变更机制各司其职：
//   manifest       — 管结构（有什么 section，放哪个 zone）
//   Router         — 管模式（不同模式显示/跳过哪些 section）
//   Injection      — 管动态注入（旁路 Agent 运行时插入内容）
//   Compressor     — 管预算保护（超 token 时如何裁剪历史）
//   ContextSource  — 管数据供应（运行时数据从哪来）
//   activeConditions — 管条件开关（如 precise_mode 触发条件注入）
//   filterHistory  — 管消息过滤（本文件，历史中哪些消息不显示）
// ============================================================

import type {
  Message,
  ToolDefinition,
} from '../types.js';
import {
  TokenCounter,
} from './tokenizer.js';
import {
  SystemPromptBuilder,
} from './prompt-builder.js';
import type { SystemPromptSection } from './prompt-builder.js';
import type { ComposeOptions, ContextComposer, ContextSource } from './interface.js';
import { createHash } from 'node:crypto';
import type { GitManager } from '../evolution/git-manager.js';
import { getManifestLoader } from '../hot-reload/manifest-watcher.js';
import type { ContextProfile } from './profiles.js';
import { NORMAL_PROFILE, getActiveRouter } from './profiles.js';
import { resolveSection } from './section-resolver.js';
import type { ResolverContext } from './section-resolver.js';
import { getCacheStrategy } from './cache-strategy.js';
import type { ZoneInfo, CacheMarker } from './cache-strategy.js';
import type { ProviderType } from '../types.js';

function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d} ${h}:${min}`;
}

/** 判断是否应跳过该历史消息 */
function shouldSkipHistoryMessage(msg: import('../types.js').Message): boolean {
  if (msg.role === 'system') return true;
  const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
  if (blocks.every(b => b.type === 'thinking')) return true;
  // 跳过纯系统注入文本
  if (blocks.every(b => b.type === 'text')) {
    const text = blocks.map(b => (b as import('../types.js').TextContent).text).join('\n');
    if (text.startsWith('[Scheduled Task]') || text.startsWith('[System]')) return true;
  }
  return false;
}

export interface LayeredComposeOptions {
  sessionDir: string;
  /** 当前 active Provider 的类型 — 决定缓存策略（断点 vs 自动前缀） */
  providerType?: ProviderType;
  maxContextTokens: number;
  cwd: string;
  timestamp: string;
  tools: ToolDefinition[];
  history: Message[];
  userInput: string;
  historySummary?: string;
  currentPlan?: string;
  selectedSkills?: string[];
  selectedAgents?: string[];
  impactInfo?: string;
  fullHistory?: Message[];
  zone3Hashes?: Set<string>;
  personaDir?: string;
  gitManager?: GitManager;
  /** 当前模式 profile — 控制 section 过滤、persona 来源、memory 来源 */
  profile?: ContextProfile;
  /** 旁路Agent 注入列表 */
  bypassInjections?: import('../bypass/types.js').Injection[];
  /** 历史消息变换（用于意图簇过滤等场景）。返回筛选后的消息，null/undefined = 不过滤。 */
  historyTransform?: ((msgs: Message[]) => Message[]) | null;
}

export type ZoneBreakdown = Record<string, number> & { total: number };

export interface LayeredContext {
  messages: Message[];
  zoneBreakdown: ZoneBreakdown;
}

export class LayeredContextComposer implements ContextComposer {
  private promptBuilder: SystemPromptBuilder;
  private tokenCounter: TokenCounter;
  private sources = new Map<string, ContextSource>();
  /** 当前激活的条件（如 precise_mode）— 由策略设置 */
  activeConditions = new Set<string>();
  private persistentSections: SystemPromptSection[] = [];
  private cwd: string;

  constructor(maxContextTokens: number = 200000) {
    this.promptBuilder = new SystemPromptBuilder();
    this.tokenCounter = new TokenCounter();
    this.cwd = process.cwd();
  }

  registerSource(source: ContextSource): void {
    this.sources.set(source.name, source);
  }

  unregisterSource(name: string): void {
    this.sources.delete(name);
  }

  getSource(name: string): ContextSource | undefined {
    return this.sources.get(name);
  }

  /** 已注册源名清单（架构监督基线上报用） */
  listSourceNames(): string[] {
    return [...this.sources.keys()];
  }

  registerPromptSection(section: SystemPromptSection): void {
    this.persistentSections.push(section);
  }

  clearPersistentSections(): void {
    this.persistentSections = [];
  }

  compose(options: LayeredComposeOptions): Promise<LayeredContext>;
  compose(options: ComposeOptions): Promise<Message[]>;
  async compose(
    options: LayeredComposeOptions | ComposeOptions,
  ): Promise<LayeredContext | Message[]> {
    this.cwd = (options as LayeredComposeOptions).cwd ?? process.cwd();

    if (this.isLayeredOptions(options)) {
      this.promptBuilder = new SystemPromptBuilder();

      for (const section of this.persistentSections) {
        this.promptBuilder.registerSection(section);
      }
      return this.composeCore(options as LayeredComposeOptions);
    }

    const composeOpts = options as ComposeOptions;
    this.promptBuilder = new SystemPromptBuilder();
    for (const section of this.persistentSections) {
      this.promptBuilder.registerSection(section);
    }
    this.promptBuilder.registerSection({
      name: 'legacy_system_prompt',
      priority: 0,
      content: composeOpts.systemPrompt,
    });
    const layeredOptions = this.toLayeredOptions(composeOpts);
    const result = await this.composeCore(layeredOptions);
    return result.messages;
  }

  async composeLegacy(options: ComposeOptions): Promise<Message[]> {
    return this.compose(options);
  }

  /**
   * 组装单个 Zone 的预览文本（供设置页展示真实内容，如 zone1 锚点区）。
   * 复用本实例已注册的 ContextSource（skills/agents/mcp/memory 等），
   * 保证预览内容与线上组装一致。Zone 不存在或未启用 → 返回 null。
   */
  async previewZone(
    zoneKey: string,
    options: LayeredComposeOptions,
  ): Promise<{ zone: string; text: string; tokens: number } | null> {
    this.cwd = options.cwd ?? process.cwd();
    this.promptBuilder = new SystemPromptBuilder();
    for (const section of this.persistentSections) {
      this.promptBuilder.registerSection(section);
    }
    const manifestLoader = getManifestLoader(this.cwd);
    const zone = manifestLoader.getZone(zoneKey);
    if (!zone || !zone.enabled) return null;
    const ctx = this.buildResolverContext(options);
    const result = await this.assembleZone(zoneKey, options, ctx);
    // 消息 content 可能是 string / {type:'text',text} / 块数组，统一提取文本
    const text = result.messages
      .map((m) => {
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
          return c
            .filter((x) => x.type === 'text')
            .map((x) => (x as { text: string }).text)
            .join('\n');
        }
        if (c && typeof c === 'object' && 'text' in c) return (c as { text: string }).text;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
    // 还原 promptBuilder 状态，避免本 Zone 的 section 泄漏到下一次 compose
    this.clearPromptBuilder();
    return { zone: zoneKey, text, tokens: result.tokens };
  }

  private buildResolverContext(options: LayeredComposeOptions): ResolverContext {
    return {
      cwd: options.cwd,
      tools: options.tools,
      userInput: options.userInput,
      timestamp: options.timestamp || formatTimestamp(),
      historySummary: options.historySummary,
      currentPlan: options.currentPlan,
      impactInfo: options.impactInfo,
      history: options.history,
      fullHistory: options.fullHistory,
      zone3Hashes: options.zone3Hashes,
      maxContextTokens: options.maxContextTokens,
      sources: this.sources,
      selectedSkills: options.selectedSkills,
      selectedAgents: options.selectedAgents,
      gitManager: options.gitManager,
      tokenCounter: this.tokenCounter,
      sessionDir: options.sessionDir,
      activeConditions: this.activeConditions,
      profile: options.profile ?? NORMAL_PROFILE,
      router: getActiveRouter(),
      bypassInjections: options.bypassInjections,
    };
  }

  private async composeCore(options: LayeredComposeOptions): Promise<LayeredContext> {
    const manifestLoader = getManifestLoader(this.cwd);
    const enabledZones = manifestLoader.getEnabledZones();

    const allMessages: Message[] = [];
    const breakdown: Record<string, number> = {};
    // 记录每个 Zone 的消息数，供缓存策略计算断点位置
    const zoneMsgCounts: ZoneInfo[] = [];

    const ctx = this.buildResolverContext(options);

    for (const [zoneKey] of enabledZones) {
      const result = await this.assembleZone(zoneKey, options, ctx);
      allMessages.push(...result.messages);
      breakdown[zoneKey] = result.tokens;
      zoneMsgCounts.push({ key: zoneKey, msgCount: result.messages.length });

      if (zoneKey === 'zone3') {
        options.zone3Hashes = this.computeHashes(result.messages);
        ctx.zone3Hashes = options.zone3Hashes;
      }
    }

    // ── 缓存策略：根据 ProviderType 在 Zone 边界打 cache_control 断点 ──
    if (options.providerType) {
      const strategy = getCacheStrategy(options.providerType);
      // 先清除旧标记（防止历史消息中残留其他 Provider 的 cache_control）
      this.clearMarkers(allMessages);
      if (strategy.shouldApplyMarkers()) {
        const markers = strategy.computeMarkers({ zones: zoneMsgCounts });
        this.applyMarkers(allMessages, markers);
      }
    }

    const totalTokens = Object.values(breakdown).reduce((sum, t) => sum + t, 0);
    const zoneBreakdown: ZoneBreakdown = { ...breakdown, total: totalTokens };

    this.clearPromptBuilder();
    return { messages: allMessages, zoneBreakdown };
  }

  private async assembleZone(
    zoneKey: string,
    options: LayeredComposeOptions,
    ctx: ResolverContext,
  ): Promise<{ messages: Message[]; tokens: number }> {
    const manifestLoader = getManifestLoader(this.cwd);
    const zone = manifestLoader.getZone(zoneKey);
    if (!zone || !zone.enabled) {
      return { messages: [], tokens: 0 };
    }

    const zoneRole = zone.role ?? 'user';

    if (zoneRole === 'system') {
      const sections = manifestLoader.getSections(zoneKey);
      for (const sec of sections) {
        if (this.promptBuilder.getSection(sec.name)) continue;
        // conditional section 也需要解析——由 resolveConditional 根据 activeConditions 决定是否注入
        if (sec.type === 'conditional') {
          const content = await resolveSection(sec, ctx);
          if (content) {
            this.promptBuilder.registerSection({
              name: sec.name,
              priority: sec.priority,
              content,
            });
          }
          continue;
        }
        const content = await resolveSection(sec, ctx);
        if (content) {
          this.promptBuilder.registerSection({
            name: sec.name,
            priority: sec.priority,
            content,
          });
        }
      }
      const systemPrompt = await this.promptBuilder.build();
      if (!systemPrompt.trim()) {
        return { messages: [], tokens: 0 };
      }
      const systemMessage: Message = {
        role: 'system',
        content: { type: 'text', text: systemPrompt },
      };
      const tokens = this.tokenCounter.countMessageTokens(systemMessage);
      return { messages: [systemMessage], tokens };
    }

    const sections = manifestLoader.getSections(zoneKey);
    const messages: Message[] = [];
    const textParts: string[] = [];
    const systemParts: string[] = [];

    const flushTextParts = () => {
      if (textParts.length > 0) {
        messages.push({ role: zoneRole, content: { type: 'text', text: textParts.join('\n\n') } });
        textParts.length = 0;
      }
    };
    const flushSystemParts = () => {
      if (systemParts.length > 0) {
        messages.push({ role: 'system' as const, content: { type: 'text', text: systemParts.join('\n\n') } });
        systemParts.length = 0;
      }
    };

    for (const sec of sections) {
      // runtime:history — 保持消息独立性（保留 role），跳过系统注入和 thinking
      if (sec.source === 'runtime:history' && options.history && options.history.length > 0) {
        flushSystemParts();
        flushTextParts();
        const historyMsgs = options.historyTransform
          ? options.historyTransform(options.history)
          : options.history;
        for (const msg of historyMsgs) {
          if (shouldSkipHistoryMessage(msg)) continue;
          messages.push(msg);
        }
        continue;
      }

      const content = await resolveSection(sec, ctx);
      if (!content) continue;

      // Router 可按"本轮该 section 的实际来源"覆写 role（如陪伴模式世界旁白 → assistant 内心独白）
      // 旁路Agent 注入也可指定 role
      const bypassRole = ctx.bypassInjections?.find(ij => ij.section === sec.name)?.role;
      const roleOverride = bypassRole ?? ctx.router.roleForSection?.(sec.name);
      const sectionRole = (roleOverride ?? sec.role ?? zoneRole) as 'system' | 'user' | 'assistant';
      const zr: string = zoneRole; // widen to avoid TS narrowing

      if (sectionRole === 'system' && zr !== 'system') {
        // 系统消息独立累积，合并成一条 system message
        flushTextParts();
        systemParts.push(content);
      } else if (sectionRole !== zr) {
        flushSystemParts();
        flushTextParts();
        messages.push({ role: sectionRole, content: { type: 'text', text: content } });
      } else {
        flushSystemParts();
        textParts.push(content);
      }
    }

    flushSystemParts();
    flushTextParts();

    if (messages.length === 0) {
      return { messages: [], tokens: 0 };
    }

    const tokens = this.tokenCounter.countMessagesTokens(messages);
    return { messages, tokens };
  }

  // --- Helpers ---

  private clearPromptBuilder(): void {
    const sections = this.promptBuilder.getAllSections();
    for (const section of sections) {
      this.promptBuilder.unregisterSection(section.name);
    }
  }

  private isLayeredOptions(
    options: LayeredComposeOptions | ComposeOptions,
  ): options is LayeredComposeOptions {
    return 'sessionDir' in options;
  }

  private computeHashes(messages: Message[]): Set<string> {
    const hashes = new Set<string>();
    for (const msg of messages) {
      const contentStr = JSON.stringify(msg.content);
      hashes.add(createHash('md5').update(contentStr).digest('hex'));
    }
    return hashes;
  }

  /**
   * 按策略计算出的断点位置，在消息的 TextContent 上打 cache_control 标记。
   *
   * 仅标记系统角色 (system/user) 的消息，跳过 assistant 角色。
   * `cache_control` 放在消息的最后一个 TextContent block 上。
   */
  /**
   * 清除所有消息上的 cache_control 标记。
   *
   * 历史消息中可能残留之前 Anthropic session 的 cache_control，
   * 当切换到 DeepSeek/OpenAI 等 auto-prefix Provider 时，必须清除。
   */
  private clearMarkers(messages: Message[]): void {
    for (const msg of messages) {
      if (msg.role === 'assistant') continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const block of blocks) {
        if ('cache_control' in block) {
          delete (block as unknown as Record<string, unknown>).cache_control;
        }
      }
    }
  }

  private applyMarkers(messages: Message[], markers: CacheMarker[]): void {
    for (const marker of markers) {
      const msg = messages[marker.index];
      if (!msg || msg.role === 'assistant') continue;

      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
      // 从后往前找最后一个 TextContent block
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === 'text' || blocks[i].type === 'image') {
          (blocks[i] as import('../types.js').TextContent).cache_control = {
            type: 'ephemeral',
          };
          break;
        }
      }
    }
  }

  private toLayeredOptions(options: ComposeOptions): LayeredComposeOptions {
    return {
      sessionDir: process.cwd(),
      maxContextTokens: options.maxContextTokens,
      cwd: process.cwd(),
      timestamp: formatTimestamp(),
      tools: options.tools,
      history: options.history,
      userInput: options.userInput,
    };
  }
}
