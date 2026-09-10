/**
 * 权限链插件（HyPlugin 格式）—— 插件化价值验证的第一个真实插件。
 *
 * 挂载面：主循环钩子总线（AgentLoop.loopHooks）。插件经 ctx.aroundHook
 * 拦截 `beforeToolExecute`，按配置过滤 denyTools 黑名单工具。
 *
 * ## 与 executeTools 内置权限的关系
 * executeTools 内置 dangerousTools/allowlistTools/requireConfirmation 权限链，
 * 本插件是**外部治理层**：即使内置权限被绕过/替换，插件层仍兜底强制。
 * 这也验证了 P1 的设计主张 —— 权限决策可以不经内核代码，以插件形式叠加。
 *
 * ## 配置（mount 第二参）
 * ```ts
 * loop.mountPlugin(createPermissionChainPlugin(), { denyTools: ['rm'] })
 * ```
 */

import type { HyPlugin } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';

export interface PermissionChainConfig {
  /** 绝对禁止执行的工具名（插件层强制） */
  denyTools?: string[];
}

/** 主循环 beforeToolExecute payload 的工具调用形状（与 loop-hooks 声明对齐） */
interface ToolCallShape {
  id: string;
  name: string;
  input: unknown;
}

export const PERMISSION_CHAIN_PLUGIN_ID = 'permission-chain';

export function createPermissionChainPlugin(): HyPlugin<Record<string, unknown>, LoopHooks> {
  return {
    id: PERMISSION_CHAIN_PLUGIN_ID,

    activate(ctx, config) {
      const cfg = (config ?? {}) as PermissionChainConfig;
      const deny = new Set(cfg.denyTools ?? []);
      // 无黑名单 → 插件空转（零开销，不注册拦截器）
      if (deny.size === 0) {
        ctx.logger.info('permission-chain: no denyTools configured, idle');
        return;
      }

      ctx.aroundHook('beforeToolExecute', async (payload, next) => {
        const calls = (payload as { calls: ToolCallShape[] }).calls ?? [];
        const blocked = calls.filter((c) => deny.has(c.name));
        if (blocked.length > 0) {
          ctx.logger.warn(
            `permission-chain blocked: ${blocked.map((c) => c.name).join(', ')}`,
          );
        }
        const allowed = calls.filter((c) => !deny.has(c.name));
        if (allowed.length === calls.length) {
          return next(payload); // 无命中 → 原样放行（不改写 payload）
        }
        return next({ ...payload, calls: allowed } as never);
      });
    },
  };
}
