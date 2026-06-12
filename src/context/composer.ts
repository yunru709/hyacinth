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
  bootstrapStatus?: 'pending' | 'complete';
  gitManager?: GitManager;
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
      bootstrapStatus: options.bootstrapStatus,
      sources: this.sources,
      selectedSkills: options.selectedSkills,
      selectedAgents: options.selectedAgents,
      gitManager: options.gitManager,
      tokenCounter: this.tokenCounter,
      activeConditions: this.activeConditions,
    };
  }

  private async composeCore(options: LayeredComposeOptions): Promise<LayeredContext> {
    const manifestLoader = getManifestLoader(this.cwd);
    const enabledZones = manifestLoader.getEnabledZones();

    if (options.bootstrapStatus === 'pending') {
      const zone4 = manifestLoader.getZone('zone4');
      if (zone4 && !enabledZones.some(([k]) => k === 'zone4')) {
        enabledZones.push(['zone4', zone4]);
        enabledZones.sort(([, a], [, b]) => a.order - b.order);
      }
    }

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
        if (sec.type === 'conditional' || this.promptBuilder.getSection(sec.name)) continue;
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
      // runtime:history 需要展开为 Message[]（非单个 string），无法通过 resolveSection() 处理。
      if (sec.source === 'runtime:history' && options.history && options.history.length > 0) {
        flushSystemParts();
        flushTextParts();
        messages.push(...options.history);
        continue;
      }

      const content = await resolveSection(sec, ctx);
      if (!content) continue;

      const sectionRole = (sec.role ?? zoneRole) as 'system' | 'user' | 'assistant';
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
