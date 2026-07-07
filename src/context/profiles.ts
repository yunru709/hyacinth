// ============================================================
// ContextProfile — 模式路由层（兼容保留）
// ============================================================
//
// 从 v2 开始，上下文路由统一由 IContextRouter（router.ts）管理。
// ContextProfile 和 ComposeStrategy 保留作为向后兼容的 deprecated 别名。
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
  return _activeRouterName === 'companion';
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
