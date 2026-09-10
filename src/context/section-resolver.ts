// ============================================================
// section-resolver — Section 解析器（7 机制之 Injection + activeConditions）
// ============================================================
//
// 职责：
//   1. Injection — 旁路 Agent 的动态注入解析。
//      在 resolveSection 中查找 bypassInjections，匹配 section name，
//      根据 mode（replace/append）注入内容。
//   2. activeConditions — 条件开关。
//      通过 ResolverContext.activeConditions 控制 conditional section
//      是否启用（如 precise_mode 触发时注入精确模式相关 prompt）。
//
// 调用链：composer → resolveSection → 根据 sec.type 分发到不同处理逻辑。
// 旁路注入优先级高于正常解析，inject mode='replace' 完全替代原内容。
// ============================================================

import type { Message, TextContent } from '../types.js';
import type { SectionEntry } from './manifest-types.js';
import type { TokenCounter } from './tokenizer.js';
import type { ContextSource } from './interface.js';
import type { GitManager } from '../evolution/git-manager.js';
import type { ContextProfile } from './profiles.js';
import type { IContextRouter } from './router.js';
import type { Injection } from '../bypass/types.js';
import { loadPrompt, renderPrompt } from '../prompts/loader.js';
import { loadProjectContext } from './prompt-builder.js';
import { Retriever } from './retriever.js';
import { zone4BudgetRatio, poolMinHistory } from './context-config.js';
import fs from 'node:fs';
import path from 'node:path';
import { getGlobalPersonaDir } from '../setup/persona-bootstrap.js';

export interface ResolverContext {
  cwd: string;
  tools: Array<{ name: string }>;
  userInput: string;
  timestamp: string;
  historySummary?: string;
  currentPlan?: string;
  impactInfo?: string;
  history?: Message[];
  fullHistory?: Message[];
  zone3Hashes?: Set<string>;
  maxContextTokens: number;
  sources?: Map<string, ContextSource>;
  selectedSkills?: string[];
  selectedAgents?: string[];
  gitManager?: GitManager;
  tokenCounter: TokenCounter;
  activeConditions?: Set<string>;
  /** 当前模式 profile——保留向后兼容，新代码使用 router */
  profile: ContextProfile;
  /** 当前模式 router——统一上下文路由入口 */
  router: IContextRouter;
  /** 旁路Agent注入列表（由 BypassManager.preTurn 产出） */
  bypassInjections?: Injection[];
}

/** 查找旁路Agent对指定 section 的注入 */
function findBypassInjection(
  sectionName: string,
  injections?: Injection[],
): Injection | undefined {
  if (!injections?.length) return undefined;
  return injections.find(ij => ij.section === sectionName);
}

export async function resolveSection(
  sec: SectionEntry,
  ctx: ResolverContext,
): Promise<string | undefined> {
  // Router 的 beforeSection 钩子：在正常解析前介入
  if (ctx.router.beforeSection) {
    const preempted = await ctx.router.beforeSection(sec, ctx);
    if (preempted !== undefined) {
      return preempted || undefined; // null → undefined（跳过此 section）
    }
  }

  // 旁路Agent 注入：replace 模式时替换整个 section 内容
  const bypassInj = findBypassInjection(sec.name, ctx.bypassInjections);
  if (bypassInj?.mode === 'replace') {
    return bypassInj.content;
  }

  // 正常解析
  let resolved: string | undefined;
  switch (sec.type) {
    case 'static':   resolved = resolveStatic(sec, ctx); break;
    case 'template': resolved = resolveTemplate(sec, ctx); break;
    case 'runtime':  resolved = await resolveRuntime(sec, ctx); break;
    case 'retrieval': resolved = await resolveRetrieval(sec, ctx); break;
    case 'conditional': resolved = resolveConditional(sec, ctx); break;
    default: resolved = undefined;
  }

  // 旁路Agent 注入：append 模式时追加到正常解析结果末尾
  if (bypassInj?.mode === 'append' && bypassInj.content) {
    resolved = resolved ? `${resolved}\n\n${bypassInj.content}` : bypassInj.content;
  }

  return resolved;
}

// --- Static ---

function resolveStatic(sec: SectionEntry, ctx?: ResolverContext): string | undefined {
  const router = ctx?.router;

  if (sec.name === 'persona_soul') {
    // precise_mode 保持原有 activeConditions 逻辑
    if (ctx?.activeConditions?.has('precise_mode')) return undefined;
    // Router 定义了替代 persona 来源 → 加载替代内容，跳过默认 SOUL
    // 注：resolve 字段用于 runtime section（异步），static section 只用 source + append。
    // 如需完全异步接管 persona，应使用 beforeSection 钩子。
    const personaOverride = router?.sourceOverrides['persona_soul'];
    if (personaOverride) {
      try {
        const effectiveSource = personaOverride.source ?? sec.source;
        let content = loadPrompt(effectiveSource.replace(/^prompts\//, ''));
        if (personaOverride.append) {
          content = content + '\n\n' + personaOverride.append;
        }
        return content;
      } catch {
        return undefined;
      }
    }
    return buildSoulSection() || undefined;
  }

  // Router 指定跳过的 section
  if (router?.skipSections.includes(sec.name)) {
    return undefined;
  }

  try {
    return loadPrompt(sec.source.replace(/^prompts\//, ''));
  } catch {
    return undefined;
  }
}

// --- Template ---

function resolveTemplate(
  sec: SectionEntry,
  ctx: ResolverContext,
): string | undefined {
  const vars: Record<string, string> = {};
  if (sec.templateVars) {
    for (const v of sec.templateVars) {
      if (v === 'cwd') vars.cwd = ctx.cwd;
      if (v === 'toolNames') {
        vars.toolNames = ctx.tools.map(t => t.name).join(', ') || '(无)';
      }
    }
  }
  try {
    return renderPrompt(loadPrompt(sec.source.replace(/^prompts\//, '')), vars);
  } catch {
    return undefined;
  }
}

// --- Runtime ---
//
// 运行时 Section 解析器。
//
// Zone 布局（详见 manifest-defaults.ts）：
//   Zone 1 (Anchor)  — 身份/环境/注册表/记忆（稳定，享受前缀缓存）
//   Zone 2 (Manifest) — 辅助索引区（默认关闭）
//   Zone 3 (History)  — 摘要/项目上下文/历史消息（持续增长，压缩器管理）
//   Zone 4 (Context)  — 知识库检索（可独立开关）
//   Zone 5 (Live)     — Flow 注入/时间戳/用户输入（每轮变化，不缓存）
//
// 通用回退规则：runtime:xxx → 查找 ctx.sources.get('xxx')，若存在则取其内容。

async function resolveRuntime(
  sec: SectionEntry,
  ctx: ResolverContext,
): Promise<string | undefined> {
  const src = sec.source;

  if (src === 'runtime:plan') {
    return ctx.currentPlan ? `[Current Plan]\n${ctx.currentPlan}` : undefined;
  }
  if (src === 'runtime:impact') {
    return ctx.impactInfo ? `[Dependency Impact Analysis]\n${ctx.impactInfo}` : undefined;
  }
  if (src === 'runtime:summary') {
    // 优先使用当前意图簇摘要（intent_cluster_summary 源已注册且有内容时）
    const clusterSource = ctx.sources?.get('intent_cluster_summary');
    if (clusterSource?.getContent) {
      const clusterText = await clusterSource.getContent();
      if (clusterText && typeof clusterText === 'string' && clusterText.trim()) {
        return `[Context Summary]\n${clusterText}`;
      }
    }
    return ctx.historySummary ? `[Context Summary]\n${ctx.historySummary}` : undefined;
  }
  if (src === 'runtime:timestamp') {
    // 时间戳的条件注入由 Router.beforeSection 控制（如 CompanionRouter 的概率注入）。
    // 此处无条件生成时间戳文本——如果 beforeSection 返回了 null，此代码不会执行。
    // # currentDate 是系统元数据标记（非用户输入），模型训练数据中识别为背景信息
    const [datePart, timePart] = ctx.timestamp.split(' ');
    const dateSlash = datePart.replace(/-/g, '/');
    return `# currentDate\n(系统提供) Today is ${dateSlash}, ${timePart}.`;
  }
  if (src === 'runtime:userInput') {
    return ctx.userInput || undefined;
  }

  if (src === 'runtime:env') {
    const envSource = ctx.sources?.get('env-info');
    if (envSource?.getContent) {
      const content = await envSource.getContent();
      return content || undefined;
    }
    return undefined;
  }

  // Router（或 profile）指定跳过的 runtime source
  const runtimeKey = src.startsWith('runtime:') ? src.slice('runtime:'.length) : '';
  const skipSources = ctx.router?.skipRuntimeSources ?? ctx.profile.skipRuntimeSources;
  if (skipSources.includes(runtimeKey)) {
    return undefined;
  }

  if (src === 'runtime:skills' || src === 'runtime:agents' || src === 'runtime:mcp') {
    // 注意：kind 必须与 ContextSource 名称前缀一致（单数）。
    // factory.ts 注册的是 'skill-*' / 'agent-*' / 'mcp-*'，
    // 若直接用 src.replace('runtime:','') 会得到复数 'skills'/'agents' 导致前缀匹配失败。
    const kind = src === 'runtime:skills' ? 'skill' : src === 'runtime:agents' ? 'agent' : 'mcp';
    return buildSourcePartsFromCtx(kind, ctx);
  }

  // 会话临时 MCP：仅收集 cacheability === 'live' 的 mcp- 源，用于 Zone 5 热插拔展示
  if (src === 'runtime:mcp_live') {
    return buildLiveMcpIndex(ctx);
  }

  // 会话临时工具：hot-reload 热添加的工具不进 Zone 2 tool_rules，而在 Zone 5 session_tools 展示
  if (src === 'runtime:tools_live') {
    return await resolveContextSourceContent('session-tools', ctx);
  }

  // MCP 状态变更通知：从 ContextSource 读取并消费，注入后自动清空
  if (src === 'runtime:mcp_status') {
    return await resolveContextSourceContent('mcp-status', ctx);
  }

  // 工具包索引（Zone 2）：所有 bundle 的名称 + 简介
  if (src === 'runtime:tool_bundles') {
    return await resolveContextSourceContent('tool-bundles', ctx);
  }

  // 模式注入（Zone 5）：plan/spec 激活时注入提示词
  // ── Flow 注入在 Zone 5（flow_injection），由 ContextSource 驱动 ──

  // runtime:history 由 composer.ts assembleZone() 专门处理（展开为 Message[]）。
  // 此处的 handler 仅作为防护：如果未来 manifest 将 history section 从 Zone 3 移走，
  // 或 composer 的硬编码拦截被移除，此处显式返回 undefined 而非静默丢失。
  // 架构说明见 §0.5 原则③：所有 runtime source 应在 section-resolver 中有显式路由。
  if (src === 'runtime:history') {
    return undefined;
  }

  // Router（或 profile）指定了替代 memory 来源 → 路由到对应 ContextSource
  if (src === 'runtime:memory') {
    const memoryOverride = ctx.router?.sourceOverrides['memory'];
    const altSourceName = memoryOverride?.source ?? ctx.profile.memorySource;
    if (altSourceName) {
      const altSource = ctx.sources?.get(altSourceName);
      if (altSource?.getContent) {
        const content = await altSource.getContent();
        return content || undefined;
      }
      return undefined;
    }
  }

  if (src.startsWith('runtime:')) {
    const key = src.slice('runtime:'.length);
    const source = ctx.sources?.get(key);
    if (source?.getContent) {
      const content = await source.getContent();
      return content || undefined;
    }
  }

  return undefined;
}

// --- Retrieval ---

async function resolveRetrieval(
  sec: SectionEntry,
  ctx: ResolverContext,
): Promise<string | undefined> {
  const routerSkipSections = ctx.router?.skipSections ?? ctx.profile.skipSections;
  if (routerSkipSections.includes(sec.name)) {
    return undefined;
  }

  const src = sec.source;

  if (src === 'runtime:projectContext') {
    const projectCtx = await loadProjectContext(ctx.cwd);
    if (projectCtx) {
      return `[Project Context from ${projectCtx.source}]\n${projectCtx.content}`;
    }
    return undefined;
  }

  if (src === 'runtime:pool' || src === 'runtime:git') {
    // 门控：工作历史不足 poolMinHistory 条时不召回（短会话召回纯属浪费 token）
    if (!ctx.fullHistory || ctx.fullHistory.length < poolMinHistory()) return undefined;

    const retriever = new Retriever();
    const result = await retriever.retrieve({
      pool: ctx.fullHistory,
      excludeLast: 1,
      excludeHashes: ctx.zone3Hashes,
      userInput: ctx.userInput,
      maxTokens: Math.floor(ctx.maxContextTokens * zone4BudgetRatio()),
      tokenCounter: ctx.tokenCounter,
      gitManager: ctx.gitManager,
      cwd: ctx.cwd,
    });

    if (src === 'runtime:pool' && result.messages.length > 0) {
      const lines: string[] = ['[Context Pool Results]'];
      for (const msg of result.messages) {
        const text = extractTextContent(msg);
        if (text) lines.push(`[${msg.role}] ${text}`);
      }
      return lines.join('\n');
    }

    if (src === 'runtime:git' && result.gitContext && result.gitContext.length > 0) {
      const lines: string[] = ['[Git Context]'];
      for (const entry of result.gitContext) {
        const filesStr = entry.files.length > 0
          ? ` (涉及: ${entry.files.slice(0, 5).join(', ')}${entry.files.length > 5 ? '...' : ''})`
          : '';
        lines.push(`${entry.hash} ${entry.message}${filesStr}`);
      }
      return lines.join('\n');
    }
  }

  return undefined;
}

// --- Conditional ---

function resolveConditional(
  sec: SectionEntry,
  ctx: ResolverContext,
): string | undefined {
  if (sec.condition === 'precise_mode') {
    if (!ctx.activeConditions?.has('precise_mode')) return undefined;
    return resolveStatic(sec, ctx);
  }

  return undefined;
}

// --- Helpers ---

const PERSONA_SOUL_FILES = ['SOUL', 'IDENTITY', 'USER'] as const;

export function buildSoulSection(): string {
  const parts: string[] = [];
  for (const name of PERSONA_SOUL_FILES) {
    try {
      const content = loadPersonaPrompt(name);
      if (content) parts.push(content);
    } catch {
      // skip
    }
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : '';
}

function loadPersonaPrompt(name: typeof PERSONA_SOUL_FILES[number]): string {
  const fileName = `${name}.md`;
  const projectPath = path.join(process.cwd(), '.agent', 'prompts', 'persona', fileName);
  if (fs.existsSync(projectPath)) {
    return fs.readFileSync(projectPath, 'utf-8');
  }

  const globalPath = path.join(getGlobalPersonaDir(), fileName);
  if (fs.existsSync(globalPath)) {
    return fs.readFileSync(globalPath, 'utf-8');
  }

  return loadPrompt(`persona/${name}`);
}

function extractTextContent(message: Message): string | null {
  const contents = Array.isArray(message.content)
    ? message.content
    : [message.content];
  // Collect text from all blocks — handles [image, text] and [text, image] messages
  const textParts = contents
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text);
  if (textParts.length > 0) return textParts.join('\n');
  // Single non-text block — return type marker
  if (contents.length === 1) {
    if (contents[0].type === 'image') return `[Image: ${(contents[0] as any).source?.media_type ?? 'unknown'}]`;
    if (contents[0].type === 'tool_use') return `[ToolUse: ${(contents[0] as any).name}]`;
    if (contents[0].type === 'tool_result') return `[ToolResult: ${(contents[0] as any).tool_use_id}]`;
  }
  return null;
}

/** 从指定名称的 ContextSource 读取内容 */
async function resolveContextSourceContent(
  sourceName: string,
  ctx: ResolverContext,
): Promise<string | undefined> {
  if (!ctx.sources) return undefined;
  const source = ctx.sources.get(sourceName);
  if (!source?.getContent) return undefined;
  // getContent 可能是 async（ContextSource 接口允许 Promise），必须 await
  // 否则 Promise 会因 typeof !== 'string' 被静默丢弃（内容丢失）
  const content = await source.getContent();
  const text = typeof content === 'string' ? content : '';
  return text || undefined;
}

/**
 * 收集所有 cacheability === 'live' 的 MCP 源，生成会话临时 MCP 索引。
 * 用于 Zone 5 session_mcp section — 热插拔 MCP 不进 Zone 2，避免破坏前缀缓存。
 * 下次启动时这些 MCP 会自动归位到 Zone 2（cacheability 变为 'manifest'）。
 */
function buildLiveMcpIndex(ctx: ResolverContext): string | undefined {
  if (!ctx.sources) return undefined;

  // 收集匹配的 live MCP 源，按 name 排序保证输出稳定
  const matchedSources: ContextSource[] = [];
  for (const [, source] of ctx.sources) {
    if (source.cacheability !== 'live') continue;
    if (!source.name.startsWith('mcp-')) continue;
    matchedSources.push(source);
  }
  matchedSources.sort((a, b) => a.name.localeCompare(b.name));

  if (matchedSources.length === 0) return undefined;

  const parts = matchedSources.map(
    (source) => `- ${source.name}: ${source.description ?? '(no description)'}`,
  );

  return `会话临时 MCP — 本次对话可用\n${parts.join('\n')}`;
}

async function buildSourcePartsFromCtx(
  kind: string,
  ctx: ResolverContext,
): Promise<string | undefined> {
  if (!ctx.sources) return undefined;

  const prefix = kind === 'mcp' ? 'mcp-' : `${kind}-`;
  const parts: string[] = [];

  // 收集匹配的 source，按 name 显式排序以保证输出稳定可预测。
  // 这确保了即使 Map 插入顺序因热插拔 remove+re-add 而改变，Zone 2 文本字节布局也不变，最大化前缀缓存命中率。
  const matchedSources: ContextSource[] = [];
  for (const [, source] of ctx.sources) {
    if (source.cacheability !== 'manifest') continue;
    if (kind !== 'mcp' && !source.name.startsWith(prefix)) continue;
    if (kind === 'mcp' && !source.name.startsWith('mcp-')) continue;
    matchedSources.push(source);
  }
  matchedSources.sort((a, b) => a.name.localeCompare(b.name));

  for (const source of matchedSources) {
    switch (source.strategy) {
      case 'always_inline':
        parts.push(`- ${source.name}: ${source.description ?? '(no description)'}`);
        break;
      case 'index_only':
        parts.push(`- ${source.name}: ${source.description ?? '(no description)'}`);
        break;
      case 'lazy_expand': {
        const isSelected = kind === 'skill'
          ? ctx.selectedSkills?.includes(source.name.replace('skill-', ''))
          : kind === 'agent'
            ? ctx.selectedAgents?.includes(source.name.replace('agent-', ''))
            : false;
        if (isSelected && source.getContent) {
          // getContent 可能是 async（ContextSource 接口允许 Promise），必须 await
          const content = await source.getContent();
          const text = typeof content === 'string' ? content : '';
          parts.push(`- ${source.name}: ${text}`);
        } else {
          parts.push(`- ${source.name}: ${source.description ?? '(lazy: expand on use)'}`);
        }
        break;
      }
      case 'phase_bound':
        break;
    }
  }

  return parts.length > 0 ? parts.join('\n') : undefined;
}
