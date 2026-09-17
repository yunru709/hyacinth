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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { Message } from '../types.js';
import type { SectionEntry } from './manifest-types.js';
import type { ResolverContext } from './section-resolver.js';
import { filterToolRounds } from './companion-filter.js';
import { CompanionSessionManager } from '../memory/companion-session.js';
import { parseNarration } from '../world-engine/agent.js';
import type { WorldEngine } from '../world-engine/agent.js';
import { companionUserId, mainUserId } from '../provider/user-id.js';

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

  /** 上次时间戳实际注入的时刻（按会话隔离）——驱动间隔概率 */
  private readonly _lastTimestampInjectAt = new Map<string, number>();

  filterHistory(history: Message[]): Message[] {
    return history;
  }

  /**
   * 时间戳概率注入（正常模式专属）。
   * 概率由「距上次实际注入的间隔」决定（见 timestampInjectProbability）：
   * 未命中 → 返回 null 跳过该 section；命中 → 推进时间基准并放行正常解析。
   */
  async beforeSection(sec: SectionEntry, ctx: ResolverContext): Promise<string | null | undefined> {
    if (sec.name !== 'timestamp') return undefined;

    const key = ctx.sessionDir ?? '__default__';
    const now = parseLocalTimestamp(ctx.timestamp) ?? Date.now();
    const last = this._lastTimestampInjectAt.get(key);
    const gapMs = last === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - last);

    if (Math.random() < timestampInjectProbability(gapMs)) {
      this._lastTimestampInjectAt.set(key, now); // 命中才推进基准
      return undefined;                          // 放行 → 正常生成时间戳文本
    }
    return null;                                 // 未命中 → 本轮不注入
  }

  getTaskPrompt(taskName: string): string {
    return `[Scheduled Task Triggered]\nYour scheduled task "${taskName}" has just been triggered. Execute it now. If this was a one-shot task, it has completed — no need to reschedule.`;
  }
}

// ── CompanionRouter ────────────────────────────────────────
// 陪伴模式：精简工具、跳过框架能力/注册表、陪伴 persona、陪伴 memory。
// 行为等价于 COMPANION_PROFILE + CompanionStrategy + 硬编码 companion 判断。

const COMPANION_TOOL_ALLOWLIST = [
  'companion_say', 'companion_mode', 'reset_companion_session',
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
  '【表达】你的话都要通过 companion_say 说出（直接输出的文字他听不到）。像这样：\n' +
  'companion_say {"text":"回来啦？今天过得怎么样？","tone":"惊喜","think":"终于等到他了","action":"放下书抬头"}\n' +
  'companion_say {"text":"早点睡吧，晚安。","tone":"温柔","action":"帮他掖好被角"}\n' +
  'text 是说出口的话（口语化）；think 是心声、action 是动作，只展示不朗读。\n' +
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

// ── 时间戳概率注入（仅普通模式） ──────────────────────────────
// 不按「轮次」也不按固定概率，而是按「距上次实际注入的间隔」动态给概率：
//   Δ ≤ 1 分钟 → 50%
//   Δ ≥ 5 分钟 → 100%
//   1~5 分钟之间线性平滑：p = 0.5 + (Δ - 60s) / 240s × 0.5
//
// 语义：刚告知过时间就无需重复（省 token、少噪音）；间隔越久越该刷新模型的
// 时间感。因为基准只在「实际注入」时推进（未命中不推进），未命中的轮次会
// 持续抬高下一轮的概率，不会长期不注入。首次（无记录）视为间隔无限大 → 必注入。
//
// 归属：只有 NormalRouter 调用；陪伴模式一律不注入时间戳（见 CompanionRouter）。

const TIMESTAMP_GAP_FLOOR_MS = 60_000;      // 1 分钟——概率下限
const TIMESTAMP_GAP_CEIL_MS = 5 * 60_000;   // 5 分钟——概率上限（必然注入）
const TIMESTAMP_PROB_FLOOR = 0.5;

/** 距上次注入的间隔（ms）→ 本轮注入概率（线性平滑） */
export function timestampInjectProbability(gapMs: number): number {
  if (gapMs <= TIMESTAMP_GAP_FLOOR_MS) return TIMESTAMP_PROB_FLOOR;
  if (gapMs >= TIMESTAMP_GAP_CEIL_MS) return 1;
  const t = (gapMs - TIMESTAMP_GAP_FLOOR_MS) / (TIMESTAMP_GAP_CEIL_MS - TIMESTAMP_GAP_FLOOR_MS);
  return TIMESTAMP_PROB_FLOOR + t * (1 - TIMESTAMP_PROB_FLOOR);
}

/** 解析 ctx.timestamp（'YYYY-MM-DD HH:mm'，本地时区）为 epoch ms；失败返回 null */
function parseLocalTimestamp(ts: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(ts ?? '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
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

/** 解析 loop 所属渠道标识（渠道级 session 隔离；优先 loop.channelKey，其次由 session 目录推导） */
function resolveChannelKey(loop: any): string {
  const key = (loop && typeof loop.channelKey === 'string' && loop.channelKey) ? loop.channelKey : '';
  if (key) return key;
  const base = path.basename((loop && loop.sessionDir) || '');
  const m = /^([a-z][a-z0-9-]*)_/.exec(base);
  return m ? m[1]! : 'tui';
}

/** 陪伴切换前的 session 记录文件（对齐 restart 工具的落盘思路，跨 loop / 跨进程恢复） */
function companionSessionsPath(): string {
  return path.join(os.homedir(), '.agent', 'companion', '.active-sessions.json');
}
function readActiveSessions(): Record<string, string> {
  try {
    const obj = JSON.parse(readFileSync(companionSessionsPath(), 'utf-8'));
    return obj && typeof obj === 'object' ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function writeActiveSessions(map: Record<string, string>): void {
  try {
    mkdirSync(path.dirname(companionSessionsPath()), { recursive: true });
    writeFileSync(companionSessionsPath(), JSON.stringify(map, null, 2), 'utf-8');
  } catch { /* 写入失败不影响切换 */ }
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

  /** 世界引擎旁路Agent 引用（通过 BypassManager 获取） */
  private worldEngineAgent: WorldEngine | null = null;

  private get worldEngineEnabled(): boolean {
    return this.worldEngineAgent?.enabled ?? false;
  }

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
    if (!this.worldEngineEnabled) return userInput;
    const agent = this.worldEngineAgent!;
    const { narration, dialogue } = parseNarration(userInput);
    // 总是刷新本轮旁白（无 [[]] 则设空，避免上一轮旁白泄漏到这一轮）
    agent.setPendingNarration(narration);
    if (!narration) return userInput; // 没有旁白，对话原样
    if (dialogue) return dialogue; // 混合输入：只把对话部分交给主 LLM，旁白已并入 narrate
    // 纯旁白（用户只发 [[环境]]、无对话）：
    //   先跑旁路 LLM，产出的环境信息作为本轮「瞬态 input」——
    //   它触发主 LLM 回应，但绝不落盘到 conversation.jsonl，
    //   下一轮发送自然消失，不会被当成用户消息。
    this._pureNarrationTurn = true;
    // 纯旁白轮不走 bypassManager.preTurn（那里等着也拿不到 pendingNarration），
    // 直接调 engine.narrate() 后立即返回
    const enriched = await agent.narrate();
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
    // 时间戳 section：仅普通模式注入（NormalRouter 的间隔概率注入）。
    // 陪伴模式一律不注入时间戳，此处只保留两件事：
    //   ① 纯旁白轮——环境信息已由 transformUserInput 作为本轮 user 输入带入，槽位留空
    //   ② 世界引擎启用——让旁白经 bypassInjections 的 replace 顶替该槽位（并标记以改 role）
    if (sec.name === 'timestamp') {
      this._timestampIsNarration = false;
      if (this._pureNarrationTurn) {
        return null;
      }
      if (this.worldEngineEnabled) {
        this._timestampIsNarration = true; // 旁白顶替槽位 → roleForSection 改以 assistant 注入
      }
      return null; // 陪伴模式不注入时间戳
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

    // 渠道级隔离：只有**发起切换的那个渠道**会切换 session（其它渠道经 getRouterForChannel
    // 拿到各自的 Router，不会跟随，也不再被「带过去」）。
    const channelKey = resolveChannelKey(loop);

    // 保存正常 session 路径（用于 deactivate 时切换回去）
    if (!(loop as any)._normalSessionDir) {
      (loop as any)._normalSessionDir = loop.sessionDir;
    }
    // 持久化该渠道切换前的 session —— loop 被重建 / 进程重启后仍能恢复
    // （对齐 restart 工具把恢复所需状态落盘的思路）
    try {
      const map = readActiveSessions();
      map[channelKey] = (loop as any)._normalSessionDir as string;
      writeActiveSessions(map);
    } catch { /* ignore */ }
    const sm = CompanionSessionManager.getInstance();
    sm.setCharacter(name);
    const companionDir = sm.getOrCreate();
    await loop.switchSession(companionDir);
    // 通知 TUI session 已切换，触发界面刷新
    (loop as any)._sessionSwitched = companionDir;

    // 切换到陪伴模式的 KVCache 隔离 ID（主Agent + 旁路）
    loop.setActiveUserId(companionUserId(name));

    // 通过 BypassManager 激活世界引擎旁路Agent
    const bypassMgr = loop.bypassManager;
    if (bypassMgr) {
      // 确保 WorldEngine 使用正确的角色名：经插件服务拿工厂（world-engine 插件未挂载时跳过，
      // 卸载后角色切换不再复活世界功能——「卸载 → 功能消失」）
      const existing = bypassMgr.getAgent('world-engine') as WorldEngine | undefined;
      if (existing) {
        const createAgent = loop.pluginHost?.get('world-engine.createAgent') as
          | ((name: string) => WorldEngine)
          | undefined;
        if (createAgent) {
          bypassMgr.register(createAgent(name));
        }
      }
      // 激活陪伴模式的旁路Agent
      await bypassMgr.activateForMode('companion');
      // 获取激活后的 WorldEngine 引用
      this.worldEngineAgent = bypassMgr.getAgent('world-engine') as WorldEngine | null;
    }
  }

  async onDeactivate(loop: any): Promise<void> {
    // 通过 BypassManager 停用旁路Agent
    try {
      await loop.bypassManager?.deactivateAll();
    } catch { /* 忽略 */ }
    this.worldEngineAgent = null;

    const channelKey = resolveChannelKey(loop);

    let normalDir = (loop as any)._normalSessionDir as string | undefined;
    // Fallback 1：loop 被重建 / 内存中无记录时，从持久化状态恢复该渠道切换前的 session
    if (!normalDir) {
      const map = readActiveSessions();
      if (typeof map[channelKey] === 'string' && map[channelKey]) normalDir = map[channelKey];
    }
    // Fallback 2：确实没有记录（如从存档恢复的陪伴会话）→ 才创建新 normal session
    if (!normalDir) {
      const { SessionManager } = await import('../memory/session.js');
      const sm = new SessionManager(process.cwd());
      const session = await sm.create('normal');
      normalDir = sm.getSessionDir(session.id);
    }
    await loop.switchSession(normalDir);
    (loop as any)._normalSessionDir = undefined;

    // 清除该渠道的持久化记录
    try {
      const map = readActiveSessions();
      if (map[channelKey]) {
        delete map[channelKey];
        writeActiveSessions(map);
      }
    } catch { /* ignore */ }

    // 恢复到普通模式的 KVCache 隔离 ID（主Agent + 旁路）
    loop.setActiveUserId(mainUserId(path.basename(normalDir)));

    // 通知 TUI session 已切换，触发界面刷新
    (loop as any)._sessionSwitched = normalDir;
  }

  getTaskPrompt(_taskName: string): string {
    return '（你忽然想和他说句话...）';
  }

  async onPostTurn(loop: any, taskName: string | null, toolWasCalled: boolean): Promise<void> {
    // 世界引擎 postTurn 已由 BypassManager.postTurn 统一调度，此处只处理陪伴模式特有的 JSONL 清理

    if (taskName !== null) {
      // 定时任务触发：删触发词+工具链，保留模型自然回复（看起来像主动搭话）
      await loop.removeTriggerFromJsonl();
    } else if (toolWasCalled) {
      // 普通工具调用：整轮抹除（用户消息+工具调用+回复全丢，模型不感知）
      await loop.cleanCompanionJsonl();
    }
  }
}
