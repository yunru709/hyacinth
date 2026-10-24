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

  // ── 模式切换的通用入口（**所有模式**可见，不是陪伴专有）──────────────
  // 新模式从此自带入口：不必再为每个模式各写一把切换工具（陪伴就曾是这样 ✗）。
  {
    const { createSwitchModeTool } = await import('../tools/runtime-control/index.js');
    toolRegistry.register(createSwitchModeTool(loop));
  }

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

  // ── 输出工具：say（说话）+ deliver（交付）─────────────────────────
  // 2026-10-25 拆分（孑遗定调）：
  //   · say     = 「嘴」：短句、会朗读、**不结束回合** —— 说完还能继续干活；
  //   · deliver = 「交付」：Markdown 长文、不朗读、**结束回合**（finalize 据
  //     sayStatus='submitted' 判停，stopReason 'say_submitted'）。
  // 两者共用 loop 侧的落盘 + 屏显通道（都在 tool_result 之后落，避免历史停在
  // user(tool_result) 造成"连续 user"被严格厂商拒绝）。
  // ⚠️ 语音不可用的提示**不再塞进 tool_result**（2026-10-25 孑遗：那是交付层噪音）：
  // TTS 状态改走 say-voice 插件的 UI 事件 + 日志，工具返回保持裸 'ok'。
  {
    const { createSayTool } = await import('../tools/say.js');
    const { createDeliverTool } = await import('../tools/deliver.js');
    toolRegistry.register(
      createSayTool((content, voice) => loop.submitSay(content, voice)),
    );
    toolRegistry.register(
      createDeliverTool((content, title) => loop.submitDeliver(content, title)),
    );
  }

  // ── goal 模式工具（2026-10-10）─────────────────────────────────────
  // 进入（/goal 命令是用户路径；enter_goal 是 agent「应用户要求」的路径）与
  // 提交验收（finish_goal → 审查子 agent）。业务全在 loop 侧，工具零依赖。
  // 注意：这两个工具属 workflow 包（按需）；但 goal 生效时 finish_goal 会被
  // loop.filterToolsForGoal **强制可见**，否则「进得去、出不来」。
  {
    const { createEnterGoalTool, createFinishGoalTool, createExitGoalTool } = await import('../tools/runtime-control/goal.js');
    toolRegistry.register(createEnterGoalTool((objective, by) => loop.enterGoal(objective, by)));
    toolRegistry.register(createFinishGoalTool((evidence, conclusion) => loop.submitGoal(evidence, conclusion)));
    toolRegistry.register(createExitGoalTool(() => loop.exitGoal('用户要求')));
  }
}
