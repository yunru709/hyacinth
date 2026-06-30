// ============================================================
// ContextProfile — 模式路由层
// ============================================================
//
// 在 compose 入口处根据当前模式（composeStrategy.name）选择 profile。
// Profile 统一定义该模式下的一切上下文组装行为：
//   - tools: 工具白名单（[] = 全部）
//   - skipSections: 跳过的 manifest section 名称
//   - skipRuntimeSources: 跳过的 runtime source key
//   - personaSource: 替代 persona_soul 的 loadPrompt 路径
//   - memorySource: 替代 runtime:memory 的 ContextSource name
//
// 新增模式只需：
//   1. 定义一个 ContextProfile 常量
//   2. 在 getActiveProfile() 中加一个 case
//   3. 在 ComposeStrategy 中标记正确的 name
// ============================================================

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
  skipRuntimeSources: ['skills', 'agents', 'mcp', 'tool_bundles', 'tool_bundle_expand', 'mcp_live', 'tools_live'],
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

// ── 全局陪伴模式标志 ──────────────────────────────────────────
// 跨 loop、跨渠道生效。设置后所有 AgentLoop 的 getActiveProfile()
// 都返回 COMPANION_PROFILE。
let _companionModeActive = false;

/** 查询陪伴模式是否全局激活 */
export function isCompanionModeActive(): boolean {
  return _companionModeActive;
}

/** 设置全局陪伴模式标志（由 companion_mode 工具调用） */
export function setCompanionModeActive(active: boolean): void {
  _companionModeActive = active;
}

/**
 * 根据全局标志返回对应的 ContextProfile。
 * 所有 loop 共享——切换后其他渠道（飞书等）同步生效。
 */
export function getActiveProfile(_strategyName?: string): ContextProfile {
  if (_companionModeActive) return COMPANION_PROFILE;
  return NORMAL_PROFILE;
}
