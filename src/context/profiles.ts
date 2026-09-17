// ============================================================
// ContextProfile — 模式路由层（兼容保留）【机制 2/7: Router】
// ============================================================
//
// 职责：Router — 管模式切换。不同模式下显示/跳过哪些 section，
//        哪些工具可用，走哪个 persona。
//
// 从 v2 开始，上下文路由统一由 IContextRouter（router.ts）管理。
// ContextProfile 保留作为向后兼容的 deprecated 别名（ComposeStrategy 旧轨已于 D2 消灭）。
//
// 7 种上下文变更机制：
//   1. manifest       — 管结构（有什么 section，放哪个 zone）
//   2. Router         — 管模式（本文件）← 当前机制
//   3. Injection      — 管动态注入（旁路 Agent 运行时插入内容）
//   4. Compressor     — 管预算保护（超 token 时如何裁剪历史）
//   5. ContextSource  — 管数据供应（运行时数据从哪来）
//   6. activeConditions — 管条件开关（如 precise_mode）
//   7. filterHistory  — 管消息过滤（历史中哪些消息不显示）
//
// 新增模式只需：
//   1. 实现 IContextRouter 接口
//   2. 调用 registerRouter(router) 注册
//   3. 调用 switchRouter(name) 切换
// ============================================================

import type { IContextRouter } from './router.js';
import { NormalRouter, CompanionRouter } from './router.js';

// ── Router Registry ─────────────────────────────────────────

const routerRegistry = new Map<string, IContextRouter>();

/** 当前全局激活的 Router 名称 */
let _activeRouterName = 'normal';

/** 注册一个 Router（通常在启动时调用） */
export function registerRouter(router: IContextRouter): void {
  routerRegistry.set(router.name, router);
}

/** 切换全局激活的 Router（由模式切换工具或生命周期调用） */
export function switchRouter(name: string): IContextRouter {
  const router = routerRegistry.get(name);
  if (!router) {
    throw new Error(`Unknown router: ${name}. Available: ${[...routerRegistry.keys()].join(', ')}`);
  }
  _activeRouterName = name;
  return router;
}

/** 获取当前全局激活的 Router */
export function getActiveRouter(): IContextRouter {
  return routerRegistry.get(_activeRouterName) ?? new NormalRouter();
}

/** 查询当前激活的 Router 名称 */
export function getActiveRouterName(): string {
  return _activeRouterName;
}

// ── 渠道级模式隔离 ──────────────────────────────────────────
// 每个渠道可拥有独立的 Router（模式）。某个渠道进入陪伴模式时，只切换该渠道
// 自己的 session，其它渠道保持各自的模式与 session（不再「切一个渠道、全渠道串台」）。
// 未显式设置模式的渠道回退到全局默认（_activeRouterName）。
/** 渠道 → Router 名称 */
const _channelRouterNames = new Map<string, string>();

/**
 * 设置指定渠道的激活 Router（channel 为空时退回全局默认）。
 * 与 switchRouter 的区别：只影响单个渠道，不会波及其它渠道。
 */
export function switchRouterForChannel(channel: string | undefined, name: string): IContextRouter {
  const router = routerRegistry.get(name);
  if (!router) {
    throw new Error(`Unknown router: ${name}. Available: ${[...routerRegistry.keys()].join(', ')}`);
  }
  if (channel) _channelRouterNames.set(channel, name);
  else _activeRouterName = name;
  return router;
}

/** 获取指定渠道当前激活的 Router（该渠道未设置时用全局默认） */
export function getRouterForChannel(channel: string | undefined): IContextRouter {
  const name = (channel && _channelRouterNames.has(channel))
    ? _channelRouterNames.get(channel)!
    : _activeRouterName;
  return routerRegistry.get(name) ?? new NormalRouter();
}

/** 查询指定渠道当前激活的 Router 名称 */
export function getRouterNameForChannel(channel: string | undefined): string {
  return (channel && _channelRouterNames.has(channel))
    ? _channelRouterNames.get(channel)!
    : _activeRouterName;
}

/** 清除指定渠道的模式覆盖（回退到全局默认） */
export function clearChannelRouter(channel: string | undefined): void {
  if (channel) _channelRouterNames.delete(channel);
}

/**
 * 由 session 目录 / 会话 ID 推导渠道标识（渠道级隔离的稳定 key 来源）。
 * 会话 ID 形如 `<channel>_YYYYMMDD-HHMMSS-xxxx`；无前缀（纯 CLI 交互）回退 fallback。
 */
export function channelKeyOf(sessionDirOrId: string | undefined, fallback = 'tui'): string {
  if (!sessionDirOrId) return fallback;
  const base = sessionDirOrId.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const m = /^([a-z][a-z0-9-]*)_/.exec(base);
  return m ? m[1]! : fallback;
}

// ── 启动时注册内置 Router ──────────────────────────────────
registerRouter(new NormalRouter());
registerRouter(new CompanionRouter());

// ── 向后兼容 API（deprecated） ──────────────────────────────

/** 定义一种模式下的上下文组装策略 */
export interface ContextProfile {
  /** 工具白名单。空数组 = 全部工具可用 */
  readonly tools: readonly string[];
  /** 工具黑名单。始终从最终结果中排除，优先级高于白名单 */
  readonly blacklist: readonly string[];
  /** 跳过的 section 名称（persona_soul, framework_capabilities 等） */
  readonly skipSections: readonly string[];
  /** 跳过的 runtime source key（skills, agents, mcp 等） */
  readonly skipRuntimeSources: readonly string[];
  /** 替代 persona_soul 的 prompt 路径（如 'prompts/persona/PartnerSoul'）。
   *  undefined = 使用默认 SOUL/IDENTITY/USER */
  readonly personaSource?: string;
  /** 替代 runtime:memory 的 ContextSource name（如 'companion_memory'）。
   *  undefined = 使用默认 memory */
  readonly memorySource?: string;
  /** 拼接到 persona 后的工具使用引导。用于强人设场景下确保关键工具仍被调用 */
  readonly toolPrompt?: string;
}

/** 正常模式：全部工具、全部 sections、默认 persona、默认 memory */
export const NORMAL_PROFILE: ContextProfile = {
  tools: [],
  blacklist: ['reset_companion_session'],
  skipSections: [],
  skipRuntimeSources: [],
};

/** 陪伴模式：精简工具、跳过框架能力/注册表、陪伴 persona、陪伴 memory */
export const COMPANION_PROFILE: ContextProfile = {
  tools: ['companion_mode', 'reset_companion_session', 'add_task', 'list_tasks', 'remove_task', 'toggle_task', 'read', 'write', 'edit'],
  blacklist: [],
  skipSections: ['persona_soul', 'framework_capabilities', 'tool_rules', 'attention', 'project_context'],
  skipRuntimeSources: ['skills', 'agents', 'mcp', 'tool_bundles', 'tool_bundle_expand', 'mcp_live', 'tools_live', 'flow', 'channel_context'],
  personaSource: 'prompts/persona/PartnerSoul',
  memorySource: 'companion_memory',
  toolPrompt: '有些事，你可以这样去做：' +
    '他离开了，道个别（companion_mode deactivate）。' +
    '这样可以和他重新聊聊了（reset_companion_session）。' +
    '得记住他刚才说的东西，到时候叫他（add_task）。' +
    '得回想一下，有哪些需要提醒他的东西。现况如何？（list_tasks）。' +
    '他之前说的那个东西不用管了，不叫了（remove_task）。' +
    '关于提醒这个事儿，他有别的想法（toggle_task）。' +
    '需要看点别的东西了（read）。' +
    '写东西喽（write）。' +
    '得改一下了（edit）。',
};

// ── 全局陪伴模式标志（deprecated） ──────────────────────────
// 保留以支持旧代码。新代码应通过 getActiveRouter().name 判断。

let _companionModeActive = false;

/**
 * @deprecated 使用 getActiveRouter().name === 'companion' 替代
 */
export function isCompanionModeActive(): boolean {
  if (_activeRouterName === 'companion') return true;
  for (const n of _channelRouterNames.values()) {
    if (n === 'companion') return true;
  }
  return false;
}

/**
 * @deprecated 使用 switchRouter('companion') / switchRouter('normal') 替代
 */
export function setCompanionModeActive(active: boolean): void {
  _companionModeActive = active;
  _activeRouterName = active ? 'companion' : 'normal';
}

/**
 * @deprecated 使用 getActiveRouter() 替代
 */
export function getActiveProfile(_strategyName?: string): ContextProfile {
  if (_activeRouterName === 'companion') return COMPANION_PROFILE;
  return NORMAL_PROFILE;
}
