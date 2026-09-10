/**
 * 旁路智能体插件（内核结构债第一批：整个 bypass 体系插件化）——
 * 把旁路 agent 的装配从 factory 硬编码迁为插件注册。
 *
 * 背景（11 号审查报告 verdict：MIGRATE_TO_PLUGIN）：
 * - 普通模式（orchestrator 旁路 agent）与陪伴模式（world-engine 旁路 agent）
 *   共用同一个 BypassManager —— bypass 是横切功能，**整个体系打包成插件**
 * - world-engine 是另一个独立功能：靠本插件的 register 能力维护
 *   （world-engine 插件 deps: ['bypass']，activate 时 ctx.require('bypass.manager')），
 *   不由本插件注册——未来维护者换成其他调度机制只改 deps
 *
 * 插件化后（与原 factory 内联装配行为等价）：
 * - BypassManager 实例创建 + ContextOrchestrator 注册迁入 activate
 * - loop.bypassManager 由本插件注入（原 factory: loop.bypassManager = bypassManager），
 *   卸载时置空（「卸载 → 功能消失」）
 * - 对外注册 'bypass.manager' 服务：world-engine 插件 deps 依赖 + factory 取回句柄
 *
 * ⚠️ 安全红线：旁路智能体 = 元认知层。注册进来的 agent 工具必须严格限制为
 * 窄工具（memory_* / inject_hint / cluster_assign / world_*），
 * 禁止 bash / read / write / edit / http_request 等通用工具。
 * 完整规则见 src/bypass/base.ts 头部。
 */
import type { HyPlugin, PluginContext } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import { BypassManager } from '../bypass/manager.js';
import { ContextOrchestrator } from '../bypass/orchestrator/index.js';
import type { ModelRouterLike } from '../bypass/base.js';

export const BYPASS_PLUGIN_ID = 'bypass';

/** bypass 插件对外暴露的服务键（world-engine 插件经 ctx.require 依赖；factory 取回句柄） */
export const BYPASS_API_KEY = 'bypass.manager';

/** 插件依赖的内核对象（factory 闭包注入；loop 用最小结构，避免插件依赖 AgentLoop 全类型） */
export interface BypassPluginServices {
  /** 模型路由（注入后所有旁路 agent 共享，register 时自动传播） */
  modelRouter: ModelRouterLike;
  /** ContextOrchestrator 的记忆文件路径（主 Agent 记忆，普通模式旁路 agent 维护） */
  memoryFilePath: string;
  /** 主循环实例——插件注入 loop.bypassManager（与原 factory 赋值等价），卸载时置空 */
  loop: { bypassManager?: BypassManager | null };
}

/**
 * 创建旁路体系插件。
 *
 * activate：new BypassManager → setModelRouter → register(ContextOrchestrator)
 * → 注入 loop.bypassManager → ctx.register('bypass.manager')。
 * 卸载：服务自动回滚 + loop.bypassManager 置空。
 */
export function createBypassPlugin(
  services: BypassPluginServices,
): HyPlugin<Record<string, unknown>, LoopHooks> {
  const { modelRouter, memoryFilePath, loop } = services;
  return {
    id: BYPASS_PLUGIN_ID,

    async activate(ctx: PluginContext<Record<string, unknown>, LoopHooks>) {
      const manager = new BypassManager();
      manager.setModelRouter(modelRouter);
      // 注册普通模式旁路 Agent（默认关闭，通过 /orchestrator on 启用——与工厂行为一致）
      manager.register(new ContextOrchestrator(memoryFilePath));

      // 注入主循环（原 factory: loop.bypassManager = bypassManager）
      loop.bypassManager = manager;
      ctx.add({
        dispose: () => {
          // 仅当仍指向本 manager 时置空（防止热替换后误清新值）
          if (loop.bypassManager === manager) loop.bypassManager = undefined;
        },
      });

      // 对外服务：world-engine 插件 deps: ['bypass']，activate 时经 require 取
      // manager 注册自己的 agent（「依靠旁路 agent 维护」= 这一行依赖）
      ctx.register(BYPASS_API_KEY, manager);

      ctx.logger.info('bypass plugin activated', {
        agents: manager.getActiveNames().length,
      });
    },
  };
}
