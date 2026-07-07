// ============================================================
// ContextRouter — 统一上下文路由器
// ============================================================
//
// 每个模式（normal / companion / world_sim 等）对应一个 Router 实例。
// Router 统一接管原本散落在 ContextProfile + ComposeStrategy + 硬编码判断
// 中的全部上下文行为。
//
// 新增模式只需：
//   1. 实现 IContextRouter 接口
//   2. 在 registerRouter() 调用中注册
//   3. 调用 switchRouter(name) 即可全局切换
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Message } from '../types.js';
import type { SectionEntry } from './manifest-types.js';
import type { ResolverContext } from './section-resolver.js';
import { filterToolRounds } from './precision/companion.js';
import { CompanionSessionManager } from '../memory/companion-session.js';
import { WorldEngine, parseNarration } from '../world-engine/index.js';

// ── SourceOverride ──────────────────────────────────────────

export interface SourceOverride {
  /**
   * 替换 source 路径。
   * 对 static section → prompt 文件路径（如 'prompts/persona/PartnerSoul'）
   * 对 runtime section → ContextSource 名称（如 'companion_memory'）
   */
  source?: string;
  /** 在解析后的内容末尾追加 */
  append?: string;
  /**
   * 完全接管 section 内容生成（优先级最高）。
   * 返回 string → 使用此内容作为 section 结果。
   * 返回 undefined → 跳过此 section（不注入任何内容）。
   */
  resolve?: (ctx: ResolverContext) => Promise<string | undefined>;
}

// ── IContextRouter ──────────────────────────────────────────

export interface IContextRouter {
  /** 路由器名称（唯一标识） */
  readonly name: string;

  // ── Tool ──
  /** 工具白名单。空数组 = 全部工具可用 */
  readonly toolAllowlist: readonly string[];
  /** 工具黑名单。始终从最终结果中排除，优先级高于白名单 */
  readonly toolBlacklist: readonly string[];

  // ── Section 过滤 ──
  /** 跳过的 section 名称（如 'persona_soul', 'framework_capabilities' 等） */
  readonly skipSections: readonly string[];
  /** 跳过的 runtime source key（如 'skills', 'agents', 'mcp' 等） */
  readonly skipRuntimeSources: readonly string[];

  // ── Source 覆写 ──
  /**
   * key = section name（如 'persona_soul', 'memory', 'world_context'）。
   * 支持三个维度的覆写：
   *   source — 替换源路径/ContextSource
   *   append — 内容后追加
   *   resolve — 完全接管
   */
  readonly sourceOverrides: Readonly<Record<string, SourceOverride>>;

  // ── 输入预处理 ──
  /**
   * 在用户输入进入消息流转（写入对话、被主 LLM 看到）之前变换它。
   * 返回替换后的对话文本。用于陪伴模式剥离 [[旁白]] 并交给旁路。
   * 未实现 = 原样返回（正常模式不处理）。
   */
  transformUserInput?(userInput: string, loop: any): Promise<string>;

  /**
   * 陪伴模式：本轮瞬态输入文本（纯环境轮由旁路 LLM 产出）。
   * 不为空时，loop 不将其落盘到 conversation store，而是由 runTurn
   * 直接注入 compose 的 userInput。本轮结束后置空。
   */
  ephemeralInput?: string | null;

  // ── History ──
  /** 在组装 Zone 3 之前过滤/变换历史消息 */
  filterHistory(history: Message[]): Message[];

  // ── Per-section 钩子 ──
  /**
   * 每个 section 正常解析之前调用。
   * - 返回 string → 使用此内容作为 section 结果
   * - 返回 null    → 跳过此 section（不注入）
   * - 返回 undefined → 继续正常解析流程
   */
  beforeSection?(sec: SectionEntry, ctx: ResolverContext): Promise<string | null | undefined>;

  /**
   * 覆写某个 section 注入时的消息 role（默认由 manifest 的 sec.role ?? zoneRole 决定）。
   * 返回 undefined = 不覆写，用默认。
   * 用途：陪伴模式下世界旁白顶替 timestamp 槽位时，改以 assistant（内心独白）注入。
   * 注意：依赖 beforeSection 先行执行（同一 section 先解析内容、再取 role），故只反映"本轮该 section 的实际来源"。
   */
  roleForSection?(name: string): 'user' | 'assistant' | 'system' | undefined;

  // ── 生命周期 ──
  /** 切换到本 Router 时调用（由 loop.syncRouter 触发） */
  onActivate?(loop: any): Promise<void>;
  /** 从本 Router 切出时调用 */
  onDeactivate?(loop: any): Promise<void>;

  // ── 定时任务 ──
  /** 生成定时任务触发时的用户提示词 */
  getTaskPrompt(taskName: string): string;

  // ── Post-turn ──
  /** 每轮 LLM 回复后的清理行为（如 JSONL 清理） */
  onPostTurn?(loop: any, taskName: string | null, toolWasCalled: boolean): Promise<void>;
}

// ── NormalRouter ───────────────────────────────────────────
// 正常模式：全部工具、全部 sections、默认 persona、默认 memory。
// 行为等价于 NORMAL_PROFILE + DefaultStrategy。

export class NormalRouter implements IContextRouter {
  readonly name = 'normal';
  readonly toolAllowlist: readonly string[] = [];
  readonly toolBlacklist = ['reset_companion_session'] as const;
  readonly skipSections: readonly string[] = [];
  readonly skipRuntimeSources: readonly string[] = [];
  readonly sourceOverrides: Readonly<Record<string, SourceOverride>> = {};

  filterHistory(history: Message[]): Message[] {
    return history;
  }

  getTaskPrompt(taskName: string): string {
    return `[Scheduled Task Triggered]\nYour scheduled task "${taskName}" has just been triggered. Execute it now. If this was a one-shot task, it has completed — no need to reschedule.`;
  }
}

// ── CompanionRouter ────────────────────────────────────────
// 陪伴模式：精简工具、跳过框架能力/注册表、陪伴 persona、陪伴 memory。
// 行为等价于 COMPANION_PROFILE + CompanionStrategy + 硬编码 companion 判断。

const COMPANION_TOOL_ALLOWLIST = [
  'companion_mode', 'reset_companion_session',
  'add_task', 'list_tasks', 'remove_task', 'toggle_task',
  'read', 'write', 'edit',
] as const;

const COMPANION_SKIP_SECTIONS = [
  'persona_soul', 'framework_capabilities', 'tool_rules', 'attention', 'project_context',
] as const;

const COMPANION_SKIP_RUNTIME_SOURCES = [
  'skills', 'agents', 'mcp', 'tool_bundles', 'tool_bundle_expand', 'mcp_live', 'tools_live',
  'flow', 'channel_context',
] as const;

const COMPANION_TOOL_PROMPT =
  '有些事，你可以这样去做：' +
  '他离开了，道个别（companion_mode deactivate）。' +
  '这样可以和他重新聊聊了（reset_companion_session）。' +
  '得记住他刚才说的东西，到时候叫他（add_task）。' +
  '得回想一下，有哪些需要提醒他的东西。现况如何？（list_tasks）。' +
  '他之前说的那个东西不用管了，不叫了（remove_task）。' +
  '关于提醒这个事儿，他有别的想法（toggle_task）。' +
  '需要看点别的东西了（read）。' +
  '写东西喽（write）。' +
  '得改一下了（edit）。';

// ── 时间戳概率注入 ────────────────────────────────────────
// 从 section-resolver.ts 迁移至此。模拟人对时间的不经意感知：
//   首条消息 / 用户主动问时间 → 100% 注入
//   连续对话中的随机轮次 → 10% 概率注入

const TIMESTAMP_INJECT_PROBABILITY = 0.30;
const FIRST_CONTACT_THRESHOLD = 4;
const TIME_QUERY_RE = /时间|几点|什么时候|时候|几点了|现在几点|什么时候了|几点钟|现在时间|现在什么时候|这会儿几点|多晚了/;

function countUserMessages(history?: Message[]): number {
  if (!history) return 0;
  return history.filter(m => m.role === 'user').length;
}

function shouldInjectTimestamp(ctx: ResolverContext): boolean {
  // 首次接触：每轮都注入时间，帮助建立时间感
  const userMsgCount = countUserMessages(ctx.history);
  if (userMsgCount <= FIRST_CONTACT_THRESHOLD) return true;

  // 用户主动问时间 → 必须注入
  if (ctx.userInput && TIME_QUERY_RE.test(ctx.userInput)) return true;

  // 连续对话：掷骰子
  return Math.random() < TIMESTAMP_INJECT_PROBABILITY;
}

/** 取某角色最后一条消息里的纯文本（供世界引擎观察上一轮对话） */
function lastTextByRole(history: Message[], role: 'user' | 'assistant'): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== role) continue;
    const blocks = Array.isArray(m.content) ? m.content : [m.content];
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => (b as any)?.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

export class CompanionRouter implements IContextRouter {
  readonly name = 'companion';
  readonly toolAllowlist = COMPANION_TOOL_ALLOWLIST;
  readonly toolBlacklist: readonly string[] = [];
  readonly skipSections = COMPANION_SKIP_SECTIONS;
  readonly skipRuntimeSources = COMPANION_SKIP_RUNTIME_SOURCES;
  readonly sourceOverrides: Readonly<Record<string, SourceOverride>> = {
    persona_soul: {
      source: 'prompts/persona/PartnerSoul',
      append: COMPANION_TOOL_PROMPT,
    },
    memory: {
      source: 'companion_memory',
    },
  };

  /** 世界引擎实例（仅陪伴模式激活期间存在；enabled 由 world-engine.json 决定，默认关） */
  private worldEngine: WorldEngine | null = null;

  /** 当前活跃的陪伴角色名（如"柔柔"），决定世界数据与对话的存储路径 */
  activeCompanionName: string = '';

  /** 本轮 timestamp 槽位是否被世界旁白顶替——决定它以 assistant（内心独白）还是 user 注入 */
  private _timestampIsNarration = false;

  /**
   * 本轮是否为「纯旁白轮」（用户只发 [[环境]]、无对话）。
   * 纯旁白轮里，环境信息已由 transformUserInput 作为本轮 user 输入注入，
   * 故 beforeSection 不再在 timestamp 槽重复注入旁白（也避免二次调用旁路 LLM）。
   */
  private _pureNarrationTurn = false;
  ephemeralInput: string | null = null;

  filterHistory(history: Message[]): Message[] {
    return filterToolRounds(history);
  }

  /**
   * 陪伴模式旁白路由：解析 [[...]] 旁白 → 交给旁路落实进世界 → 返回剥离后的对话。
   * 纯旁白（无对话）时返回一个轻量触发，让陪伴角色对更新后的场景做出反应。
   * 世界引擎未开启则原样返回（等价无操作）。
   */
  async transformUserInput(userInput: string): Promise<string> {
    this._pureNarrationTurn = false; // 每轮先复位
    this.ephemeralInput = null;      // 每轮先清除
    if (!this.worldEngine?.enabled) return userInput;
    const { narration, dialogue } = parseNarration(userInput);
    // 总是刷新本轮旁白（无 [[]] 则设空，避免上一轮旁白泄漏到这一轮）
    this.worldEngine.setPendingNarration(narration);
    if (!narration) return userInput; // 没有旁白，对话原样
    if (dialogue) return dialogue; // 混合输入：只把对话部分交给主 LLM，旁白已并入 narrate
    // 纯旁白（用户只发 [[环境]]、无对话）：
    //   先跑旁路 LLM，产出的环境信息作为本轮「瞬态 input」——
    //   它触发主 LLM 回应，但绝不落盘到 conversation.jsonl，
    //   下一轮发送自然消失，不会被当成用户消息。
    this._pureNarrationTurn = true;
    const enriched = await this.worldEngine.narrate();
    const trigger = enriched || narration;
    this.ephemeralInput = trigger; // loop 用它注入 compose，但不 append
    return trigger;
  }

  async beforeSection(sec: SectionEntry, ctx: ResolverContext): Promise<string | null | undefined> {
    // 角色 persona：从角色目录读取（~/.agent/companion/<name>/persona.md）
    if (sec.name === 'persona_soul' && this.activeCompanionName) {
      const file = path.join(os.homedir(), '.agent', 'companion', this.activeCompanionName, 'persona.md');
      try {
        let content = await fs.readFile(file, 'utf-8');
        const append = this.sourceOverrides['persona_soul']?.append;
        if (append) content = content + '\n\n' + append;
        return content;
      } catch {
        // 文件不存在 → 返回空 persona（不降级到旧路径）
        return '';
      }
    }
    // 时间戳 section：世界引擎开启时用旁白化环境替换时间戳槽位
    if (sec.name === 'timestamp') {
      this._timestampIsNarration = false; // 每轮先复位
      // 纯旁白轮：环境信息已作为本轮 user 输入注入，勿在 timestamp 槽重复注入（同时避免二次调用旁路）
      if (!this._pureNarrationTurn && this.worldEngine?.enabled) {
        const narration = await this.worldEngine.narrate();
        if (narration) {
          this._timestampIsNarration = true; // 本轮是世界旁白 → 以 assistant（内心独白）注入
          return narration; // 世界旁白替换时间戳
        }
        // 世界尚空 → 回落正常时间戳概率逻辑
      }
      if (!shouldInjectTimestamp(ctx)) {
        return null; // 此轮跳过时间戳
      }
    }
    return undefined; // 其他 section：继续正常解析
  }

  /** 世界旁白顶替 timestamp 槽位时，以 assistant 身份注入，读起来像陪伴者的内心独白 */
  roleForSection(name: string): 'user' | 'assistant' | 'system' | undefined {
    if (name === 'timestamp' && this._timestampIsNarration) return 'assistant';
    return undefined;
  }

  async onActivate(loop: any): Promise<void> {
    // 角色名未设置时，尝试从 .last-character 恢复上次使用的角色
    if (!this.activeCompanionName) {
      try {
        const last = await fs.readFile(
          path.join(os.homedir(), '.agent', 'companion', '.last-character'), 'utf-8'
        );
        const restored = last.trim();
        if (restored) this.activeCompanionName = restored;
      } catch {}
    }
    if (!this.activeCompanionName) return;
    const name = this.activeCompanionName;

    // 保存正常 session 路径（用于 deactivate 时切换回去）
    if (!(loop as any)._normalSessionDir) {
      (loop as any)._normalSessionDir = loop.sessionDir;
    }
    const sm = CompanionSessionManager.getInstance();
    sm.setCharacter(name);
    const companionDir = sm.getOrCreate();
    await loop.switchSession(companionDir);
    // 通知 TUI session 已切换，触发界面刷新
    (loop as any)._sessionSwitched = companionDir;

    // 启动世界引擎（以角色名构造，world.json 落在 ~/.agent/companion/<name>/ 下）
    try {
      this.worldEngine = new WorldEngine(name, (loop as any).modelRouter ?? null);
      await this.worldEngine.start();
    } catch {
      this.worldEngine = null; // 世界引擎启动失败绝不影响陪伴模式
    }
  }

  async onDeactivate(loop: any): Promise<void> {
    // 停世界引擎：停定时器 + 落盘 + 释放，退出后零占用
    try {
      await this.worldEngine?.stop();
    } catch { /* 忽略 */ }
    this.worldEngine = null;

    let normalDir = (loop as any)._normalSessionDir as string | undefined;
    // Fallback：从存档恢复的陪伴会话没有保存 _normalSessionDir，需要创建新 normal session
    if (!normalDir) {
      const { SessionManager } = await import('../memory/session.js');
      const sm = new SessionManager(process.cwd());
      const session = await sm.create('normal');
      normalDir = sm.getSessionDir(session.id);
    }
    await loop.switchSession(normalDir);
    (loop as any)._normalSessionDir = undefined;
    // 通知 TUI session 已切换，触发界面刷新
    (loop as any)._sessionSwitched = normalDir;
  }

  getTaskPrompt(_taskName: string): string {
    return '（你忽然想和他说句话...）';
  }

  async onPostTurn(loop: any, taskName: string | null, toolWasCalled: boolean): Promise<void> {
    // 世界引擎后置：观察这一轮对话，后台生长世界（写串行、不阻塞、不影响主流程）
    if (this.worldEngine?.enabled) {
      try {
        const history: Message[] = await loop.conversationStore.readAll(loop.sessionDir);
        const userInput = lastTextByRole(history, 'user');
        const mainOutput = lastTextByRole(history, 'assistant');
        if (userInput || mainOutput) this.worldEngine.observe(userInput, mainOutput);
      } catch { /* 忽略 */ }
    }

    if (taskName !== null) {
      // 定时任务触发：删触发词+工具链，保留模型自然回复（看起来像主动搭话）
      await loop.removeTriggerFromJsonl();
    } else if (toolWasCalled) {
      // 普通工具调用：整轮抹除（用户消息+工具调用+回复全丢，模型不感知）
      await loop.cleanCompanionJsonl();
    }
  }
}
