/**
 * tool-registration.ts —— 工具注册接线抽离（行数收尾第十二批）。
 *
 * 把 factory 内联的 runtime-control 工具批（:612-657，~50 行）抽为一次调用
 * registerLoopDependentTools(deps)。这些工具依赖 loop 实例（AgentLoop 构造后
 * 才能注册），时序锚「依赖 loop 的紧跟在构造之后」由调用点位置承载。
 *
 * 抽离后 factory 的守卫 C2 注释锚（:863 时序约束）随块移入本文件头 ——
 * 守卫 C2 的锚同步更新为调用点文本。
 */

import type { ToolRegistry } from '../tools/registry.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ProviderRouter } from '../provider/router.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { HeartbeatScheduler } from '../schedule/scheduler.js';
import type { MCPSystem } from '../mcp/system.js';
import type { AgentLoop } from '../orchestrator/loop.js';
import type { MachineRegistry } from '../machine/index.js';
import type { GitManager } from '../evolution/git-manager.js';
import type { TurnStore } from '../rollback/index.js';
import { createTriggerCompressionTool } from '../tools/compression.js';
import { createRollbackStatusTool, createRollbackTool } from '../rollback/index.js';
import { createFlowStartTool, createFlowAddTool, createFlowCompleteTool } from '../tools/flow.js';
import { createAskUserTool } from '../tools/ask-user.js';
import type { CompanionSessionManager } from '../memory/companion-session.js';

export interface LoopDependentToolDeps {
  toolRegistry: ToolRegistry;
  loop: AgentLoop;
  providerRouter: ProviderRouter;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
  configCenter: RuntimeConfigCenter;
  cwd: string;
  heartbeatScheduler: HeartbeatScheduler;
  mcpSystem: MCPSystem;
  modelRouter: ModelRouter;
  sessionDir: string;
  gitManager: GitManager;
  turnStore: TurnStore;
  flowRegistry: MachineRegistry;
  companionSessionManager: CompanionSessionManager;
}

/**
 * 注册「依赖 loop 的」运行时工具批（AgentLoop 构造后调用）。
 * 不依赖 loop 的工具在 AgentLoop 之前注册（原 factory 纪律，位置承载时序）。
 */
export async function registerLoopDependentTools(deps: LoopDependentToolDeps): Promise<void> {
  const { loop, toolRegistry, configCenter, cwd, providerRouter, skillRegistry, agentRegistry, heartbeatScheduler, mcpSystem, modelRouter, sessionDir, gitManager, turnStore, flowRegistry, companionSessionManager } = deps;

  toolRegistry.registerConfigTools(configCenter);
  // registerRuntimeControlTools 内有 switch_provider / set_mode 等 30+ 工具依赖 loop 实例
  toolRegistry.registerRuntimeControlTools(loop, providerRouter, skillRegistry, agentRegistry, configCenter, cwd, heartbeatScheduler, mcpSystem, modelRouter);
  toolRegistry.register(createTriggerCompressionTool({
    setDeepCompressState: (state) => loop.setDeepCompressState(state),
    setNeedsCompression: (v) => loop.setNeedsCompression(v),
  }));

  // destroy_sub_agent 需要 sessionDir，在此单独注册
  const { createDestroySubAgentTool } = await import('../tools/runtime-control/index.js');
  toolRegistry.register(createDestroySubAgentTool(agentRegistry, sessionDir));

  // ── 陪伴模式工具注册 ──────────────────────────────────────────────
  const { createCompanionModeTool, createResetCompanionSessionTool } = await import('../tools/runtime-control/index.js');
  toolRegistry.register(createCompanionModeTool(loop, companionSessionManager));
  toolRegistry.register(createResetCompanionSessionTool(loop, companionSessionManager));
  // 陪伴表达工具：主 agent 唯一"开口"通道（渲染 UI + 触发 TTS + 捕获给旁路）
  {
    const { createCompanionSayTool } = await import('../tools/companion-say.js');
    toolRegistry.register(createCompanionSayTool(loop));
  }
  // 音色库管理**不提供 agent 工具**：参考音频是用户录的真人声音（不可重建），
  // 登记/删除/绑定属于用户配置，统一由设置页经协议层 companion.voiceRegister /
  // voiceDelete / voiceBind 操作。模型只在 companion_say 里"选用"音色。

  // ── 回合回滚工具 ──
  toolRegistry.register(createRollbackStatusTool(turnStore, () => loop.turnNumber));
  toolRegistry.register(createRollbackTool(turnStore, gitManager, () => loop.turnNumber));

  // ── Flow 控制工具 ──
  toolRegistry.register(createFlowStartTool(flowRegistry));
  toolRegistry.register(createFlowAddTool(flowRegistry));
  toolRegistry.register(createFlowCompleteTool(flowRegistry));

  // ── 用户交互工具 ──
  toolRegistry.register(createAskUserTool(() => loop.getAskUserHandler()));
}
