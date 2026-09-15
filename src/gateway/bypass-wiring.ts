/**
 * bypass-wiring.ts —— 旁路/陪伴体系接线抽离（行数收尾第十四批）。
 *
 * 抽离 factory 中 bypass/permission-chain 两个内核 loop 插件的 mount 区 +
 * bypassManager 模式激活。均为 fail-fast（元认知安全层挂不上必须显式失败）。
 *
 * 陪伴模式 + 世界引擎已打包为**目录插件**（plugins/companion/，注册式启停）：
 * 内核只提供轻量能力服务（bypass.manager / world-engine.createAgent / context.mode，
 * 见 agent-assembly），世界引擎 agent 的装配/激活完全由 companion 插件驱动，
 * 不再作为内核插件被无条件 mount。
 *
 * 均为「纯接线」，函数化 + deps 注入（同 runtime-wiring.ts 模式）。
 */

import type { AgentLoop } from '../orchestrator/loop.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { AgentConfig } from '../setup/config.js';
import type { SessionType } from '../types.js';
import type { BypassManager } from '../bypass/manager.js';
import { createPermissionChainPlugin } from '../plugins/permission-chain.js';
import { createBypassPlugin } from '../plugins/bypass-plugin.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('factory');

export interface BypassWiringDeps {
  loop: AgentLoop;
  config: AgentConfig;
  configCenter: RuntimeConfigCenter;
  modelRouter: ModelRouter;
  memoryFilePath: string;
  sessionType: SessionType;
}

/**
 * 挂载 permission-chain（denyTools 治理层，fail-fast）、bypass（旁路体系基座，
 * fail-fast）两个内核插件，并按 sessionType 激活对应旁路 agent。
 * 返回 bypassManager（可能 undefined）。
 */
export async function mountBypassPlugins(deps: BypassWiringDeps): Promise<BypassManager | undefined> {
  const { loop, config, configCenter, modelRouter, memoryFilePath, sessionType } = deps;

  // ── 权限链插件（P2 插件化价值验证：真实插件挂主循环钩子，denyTools 外部治理层） ──
  const denyTools = config.safety?.denyTools;
  if (denyTools && denyTools.length > 0) {
    try {
      await loop.mountPlugin(createPermissionChainPlugin(), { denyTools });
    } catch (err) {
      // B-4 fail-fast：外部治理层（denyTools）挂不上必须显式失败，不能静默绕过安全配置
      logger.error('permission-chain mount failed', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  // ── 旁路 agent 体系（插件化）───────────────────────────────────
  // bypass 插件 = 整个旁路体系（BypassManager + ContextOrchestrator 注册 + loop 注入）；
  // 原内联装配（new BypassManager + 两个 register + loop.bypassManager 赋值）
  // 全部迁入插件 activate；此处只 mount + 取回 manager。
  try {
    await loop.mountPlugin(createBypassPlugin({ modelRouter, memoryFilePath, loop }));
  } catch (err) {
    logger.error('bypass plugin mount failed', err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  // 插件 activate 时注入 loop.bypassManager；mount 失败则为 undefined（下方调用点已判空）
  const bypassManager = loop.bypassManager;

  // 普通模式：根据配置决定是否激活 orchestrator（默认关闭）
  if (sessionType === 'normal') {
    const orchestratorEnabled = configCenter.get<boolean>('bypass.orchestratorEnabled') ?? false;
    if (orchestratorEnabled) {
      bypassManager?.activateAgent('orchestrator').catch(() => {});
    }
  }

  return bypassManager;
}
