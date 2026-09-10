// ============================================================
// runtime-control 工具工厂聚合出口
// ============================================================
// 原 src/tools/runtime-control.ts（2023 行）按域拆分：
//   provider.ts      — switch_provider / list_providers / provider_info / switch_to_auto_route
//   toggle.ts        — tool/skill/sub-agent 的 toggle + list
//   subagent.ts      — 子 Agent 异步任务与生命周期（list/get/spawn/create/update/destroy）
//   session.ts       — interrupt / current_session / session_stats / session 管理
//   allowlist.ts     — allow_tool / disallow_tool / list_allowlist
//   task.ts          — add/remove/list/toggle_task
//   model-channel.ts — mcp_status + 模型通道管理
//   companion.ts     — companion_mode / reset_companion_session
// 消费方（tool.registry.ts / factory.ts）统一从此入口导入，零行为变化。

export {
  createSwitchProviderTool,
  createListProvidersTool,
  createProviderInfoTool,
  createSwitchToAutoRouteTool,
} from './provider.js';

export {
  createToggleToolTool,
  createListToolsTool,
  createToggleSkillTool,
  createListSkillsTool,
  createToggleSubAgentTool,
  createListSubAgentsTool,
} from './toggle.js';

export {
  createListSubAgentTasksTool,
  createGetSubAgentResultTool,
  createSpawnSubAgentTool,
  createCreateSubAgentTool,
  createUpdateSubAgentTool,
  createDestroySubAgentTool,
} from './subagent.js';

export {
  createInterruptTool,
  createCurrentSessionTool,
  createSessionStatsTool,
  createListSessionsTool,
  createNewSessionTool,
  createSwitchSessionTool,
  createDeleteSessionTool,
} from './session.js';

export { createSessionForkTool } from '../session-fork.js';

export {
  createAllowToolTool,
  createDisallowToolTool,
  createListAllowlistTool,
} from './allowlist.js';

export {
  createAddTaskTool,
  createRemoveTaskTool,
  createListTasksTool,
  createToggleTaskTool,
} from './task.js';

export {
  createMcpStatusTool,
  createListModelChannelsTool,
  createAddModelChannelTool,
  createRemoveModelChannelTool,
  createSetChannelModelTool,
  createResetChannelModelTool,
  createChannelInfoTool,
  createSetChannelRoleTool,
} from './model-channel.js';

export {
  createCompanionModeTool,
  createResetCompanionSessionTool,
} from './companion.js';
