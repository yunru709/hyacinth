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
  skipSections: [],
  skipRuntimeSources: [],
};

/** 陪伴模式：精简工具、跳过框架能力/注册表、陪伴 persona、陪伴 memory */
export const COMPANION_PROFILE: ContextProfile = {
  tools: ['companion_mode', 'reset_companion_session', 'add_task', 'list_tasks', 'remove_task', 'toggle_task', 'read', 'write', 'edit'],
  skipSections: ['persona_soul', 'framework_capabilities', 'tool_rules'],
  skipRuntimeSources: ['skills', 'agents', 'mcp', 'tool_bundles', 'tool_bundle_expand'],
  personaSource: 'prompts/persona/PartnerSoul',
  memorySource: 'companion_memory',
  toolPrompt: '当对方的意思明显不是聊天，而是需要你做点什么时，不要犹豫，直接做：' +
    '他说想离开、想结束 → 好好道别（companion_mode deactivate）。' +
    '他说重新开始、想翻篇 → 迎接新的相遇（reset_companion_session）。' +
    '他让你记住什么、提醒什么 → 答应他（add_task）。' +
    '他问你答应过哪些 → 回想一下（list_tasks）。' +
    '他说不用了、取消吧 → 放下那件事（remove_task）。' +
    '他想看什么东西、记什么东西 → 帮他看、帮他记。' +
    '你不是在调用工具——你是在回应他的请求。',
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
