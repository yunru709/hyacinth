// ============================================================
// ModeProfile —— 声明式模式 profile + 具名钩子
// ============================================================
//
// 新增一种上下文模式的最便宜路径：写一个 JSON profile（静态部分：
// 工具面 / section 过滤 / source 覆写），代码逻辑（输入变换、session
// 解析等）以**具名钩子**引用——启动时或插件经 registerModeHook 注册。
//
// 加载：~/.agent/modes/*.json（全局）+ <cwd>/.agent/modes/*.json（项目覆盖），
// 启动时经 loadModeProfiles() 注册进 Router 注册表（profiles.ts）。
// 模式名 = session type：建对应类型的 session 即进入该模式。
//
// 内置 normal / companion 仍为代码 Router（生命周期编排复杂）；声明式
// profile 面向「静态组装 + 少量钩子」的新模式（如 coding / 受限对外）。
// ============================================================

import type { Message } from '../types.js';
import type { SectionEntry } from './manifest-types.js';
import type { ResolverContext } from './section-resolver.js';
import type { IContextRouter, ModeOutputProtocol, SourceOverride } from './router.js';

// ── 具名钩子注册表 ─────────────────────────────────────────

/** 钩子签名按用途区分；实现方经 registerModeHook 注册，profile 按名引用 */
export type ModeHook =
  | ((userInput: string, loop: unknown) => Promise<string>)                       // transformUserInput
  | ((raw: Message[]) => Message[])                                              // materializeHistory
  | ((sec: SectionEntry, ctx: ResolverContext) => Promise<string | null | undefined>) // beforeSection
  | ((name: string) => 'user' | 'assistant' | 'system' | undefined)              // roleForSection
  | ((loop: unknown) => Promise<string | undefined>);                            // resolveSession（返回目标 session 目录）

const modeHooks = new Map<string, ModeHook>();

/** 注册具名模式钩子（启动时/插件；profile 以名引用） */
export function registerModeHook(name: string, hook: ModeHook): void {
  modeHooks.set(name, hook);
}

/** 按名取钩子（未注册返回 undefined） */
export function getModeHook(name: string | undefined): ModeHook | undefined {
  return name ? modeHooks.get(name) : undefined;
}

/** 已注册钩子名（诊断用） */
export function listModeHookNames(): string[] {
  return [...modeHooks.keys()];
}

// ── 输出协议注册表 ─────────────────────────────────────────

const outputProtocols = new Map<string, () => ModeOutputProtocol>();

/** 注册具名输出协议工厂（profile.outputProtocol 按名引用） */
export function registerModeOutputProtocol(name: string, factory: () => ModeOutputProtocol): void {
  outputProtocols.set(name, factory);
}

function getOutputProtocolFactory(name: string | undefined): (() => ModeOutputProtocol) | undefined {
  return name ? outputProtocols.get(name) : undefined;
}

// ── Profile 类型 ───────────────────────────────────────────

/** 声明式模式 profile（.agent/modes/<name>.json） */
export interface ModeProfile {
  /** 模式名 = session type（须与文件名一致） */
  name: string;
  /** 一句话描述（诊断/UI 展示用） */
  description?: string;
  /** 工具白名单。缺省/空数组 = 全部工具可用 */
  toolAllowlist?: string[];
  /** 工具黑名单。始终排除，优先级高于白名单 */
  toolBlacklist?: string[];
  /** 跳过的 section 名 */
  skipSections?: string[];
  /** 跳过的 runtime source key */
  skipRuntimeSources?: string[];
  /**
   * section 覆写。source/append 为静态声明；resolveHook 引用具名钩子
   * （签名同 SourceOverride.resolve：(ctx) => Promise<string | undefined>）。
   */
  sourceOverrides?: Record<string, { source?: string; append?: string; resolveHook?: string }>;
  /** 具名钩子引用（见 ModeHook 各签名） */
  hooks?: {
    /** 用户输入预处理（进消息流之前变换） */
    transformUserInput?: string;
    /** 历史读入时的物化变换 */
    materializeHistory?: string;
    /** per-section 前置钩子 */
    beforeSection?: string;
    /** section 注入 role 覆写 */
    roleForSection?: string;
    /** 激活时解析目标 session 目录（返回 undefined = 不切 session） */
    resolveSession?: string;
    /** 激活时的 KVCache 隔离 ID（返回字符串） */
    userIdHook?: string;
  };
  /** 输出协议名（registerModeOutputProtocol 注册的工厂） */
  outputProtocol?: string;
  /** 激活时经 bypassManager.activateForMode 激活的旁路模式名 */
  bypassMode?: string;
  /** 定时任务触发提示词模板（{{task}} 占位） */
  taskPrompt?: string;
  /** 回合后清理动作（Router.onPostTurn 按序执行） */
  postTurnCleanup?: Array<'erase-tool-rounds' | 'erase-task-trigger'>;
}

// ── DeclarativeRouter ──────────────────────────────────────

/**
 * 由 ModeProfile 构造的声明式 Router。
 * 静态部分（工具面/过滤/覆写）读 profile；动态行为经具名钩子引用；
 * 激活/停用走通用编排（切 session → 换 userId → 激活旁路）。
 */
export class DeclarativeRouter implements IContextRouter {
  readonly name: string;
  readonly toolAllowlist: readonly string[];
  readonly toolBlacklist: readonly string[];
  readonly skipSections: readonly string[];
  readonly skipRuntimeSources: readonly string[];
  readonly sourceOverrides: Readonly<Record<string, SourceOverride>>;

  constructor(private readonly profile: ModeProfile) {
    this.name = profile.name;
    this.toolAllowlist = profile.toolAllowlist ?? [];
    this.toolBlacklist = profile.toolBlacklist ?? [];
    this.skipSections = profile.skipSections ?? [];
    this.skipRuntimeSources = profile.skipRuntimeSources ?? [];
    const overrides: Record<string, SourceOverride> = {};
    for (const [key, o] of Object.entries(profile.sourceOverrides ?? {})) {
      const hook = getModeHook(o.resolveHook);
      overrides[key] = {
        source: o.source,
        append: o.append,
        resolve: hook
          ? (ctx) => (hook as (c: ResolverContext) => Promise<string | undefined>)(ctx)
          : undefined,
      };
    }
    this.sourceOverrides = overrides;
  }

  /** profile 一句话描述 */
  get description(): string {
    return this.profile.description ?? '';
  }

  async transformUserInput?(userInput: string, loop: unknown): Promise<string> {
    const hook = getModeHook(this.profile.hooks?.transformUserInput) as
      | ((u: string, l: unknown) => Promise<string>)
      | undefined;
    if (!hook) return userInput;
    return hook(userInput, loop);
  }

  materializeHistory?(raw: Message[]): Message[] {
    const hook = getModeHook(this.profile.hooks?.materializeHistory) as
      | ((raw: Message[]) => Message[])
      | undefined;
    return hook ? hook(raw) : raw;
  }

  filterHistory(history: Message[]): Message[] {
    return history;
  }

  beforeSection?(sec: SectionEntry, ctx: ResolverContext): Promise<string | null | undefined> {
    const hook = getModeHook(this.profile.hooks?.beforeSection) as
      | ((s: SectionEntry, c: ResolverContext) => Promise<string | null | undefined>)
      | undefined;
    return hook ? hook(sec, ctx) : Promise.resolve(undefined);
  }

  roleForSection?(name: string): 'user' | 'assistant' | 'system' | undefined {
    const hook = getModeHook(this.profile.hooks?.roleForSection) as
      | ((n: string) => 'user' | 'assistant' | 'system' | undefined)
      | undefined;
    return hook ? hook(name) : undefined;
  }

  async onActivate(loop: unknown): Promise<void> {
    // 通用编排：解析目标 session（钩子）→ 切 session → 换 userId → 激活旁路
    const l = loop as {
      switchSession(dir: string): Promise<void>;
      setActiveUserId(id: string): void;
      bypassManager?: { activateForMode(mode: string): Promise<void> } | null;
      sessionDir: string;
    };
    const resolveSession = getModeHook(this.profile.hooks?.resolveSession) as
      | ((l: unknown) => Promise<string | undefined>)
      | undefined;
    const targetDir = await resolveSession?.(loop);
    if (targetDir && targetDir !== l.sessionDir) {
      await l.switchSession(targetDir);
    }
    const userIdHook = getModeHook(this.profile.hooks?.userIdHook) as
      | ((l: unknown) => Promise<string>)
      | undefined;
    if (userIdHook) {
      l.setActiveUserId(await userIdHook(loop));
    }
    if (this.profile.bypassMode) {
      await l.bypassManager?.activateForMode(this.profile.bypassMode).catch(() => {});
    }
  }

  async onDeactivate?(loop: unknown): Promise<void> {
    const l = loop as {
      bypassManager?: { deactivateAll(): Promise<void> } | null;
      sessionDir: string;
    };
    // 通用停用：停本模式激活的旁路（若声明过 bypassMode）
    if (this.profile.bypassMode) {
      await l.bypassManager?.deactivateAll().catch(() => {});
    }
  }

  getTaskPrompt(taskName: string): string {
    const tpl = this.profile.taskPrompt;
    if (tpl) return tpl.replace(/\{\{task\}\}/g, taskName);
    return `[Scheduled Task Triggered]\nYour scheduled task "${taskName}" has just been triggered. Execute it now. If this was a one-shot task, it has completed — no need to reschedule.`;
  }

  async onPostTurn(
    loop: unknown,
    taskName: string | null,
    _toolWasCalled: boolean,
  ): Promise<void> {
    const l = loop as {
      eraseLastToolRoundJsonl?(): Promise<void>;
      removeTaskTriggerJsonl?(): Promise<void>;
    };
    const actions = this.profile.postTurnCleanup ?? [];
    for (const action of actions) {
      if (action === 'erase-task-trigger' && taskName !== null) {
        await l.removeTaskTriggerJsonl?.();
      } else if (action === 'erase-tool-rounds' && taskName === null) {
        await l.eraseLastToolRoundJsonl?.();
      }
    }
  }

  readonly outputProtocol?: ModeOutputProtocol;

  /** 挂载输出协议（profile.outputProtocol 引用的工厂产品；加载器在构造后调用） */
  attachOutputProtocol(): void {
    const factory = getOutputProtocolFactory(this.profile.outputProtocol);
    if (factory) {
      (this as { outputProtocol?: ModeOutputProtocol }).outputProtocol = factory();
    }
  }
}
