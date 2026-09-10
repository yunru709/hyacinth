// ============================================================
// UI 协议层 — 旁路 agent 编排域（orchestrator.*）
// ============================================================
// 覆盖 UI 对旁路 agent（对应 TUI /orchestrator on|off）的控制：
//   orchestrator.get          查询 orchestrator 旁路 agent 是否激活
//   orchestrator.setEnabled   激活/停用 orchestrator 旁路 agent
//
// 依赖结构化 BypassManagerLike 接口（真实 BypassManager 天然
// 兼容：isActive/activateAgent/deactivateAgent/getActiveNames），
// 可独立测试。
// ============================================================

import type { DomainHandler } from '../server.js';
import type { OrchestratorState } from '../types.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实 BypassManager 兼容）
// ────────────────────────────────────────────────────────────

export interface BypassManagerLike {
  /** 某旁路 agent 是否激活 */
  isActive(name: string): boolean;
  /** 手动激活指定旁路 agent */
  activateAgent?(name: string): Promise<void>;
  /** 手动停用指定旁路 agent */
  deactivateAgent?(name: string): Promise<void>;
  /** 当前激活的全部旁路 agent 名称 */
  getActiveNames?(): string[];
}

// ────────────────────────────────────────────────────────────
// 旁路 agent 编排域选项
// ────────────────────────────────────────────────────────────

export interface OrchestratorDomainOptions {
  /** 动态获取旁路 manager（agent 在 initialize 后才就绪，通过闭包延迟解析） */
  getBypassManager: () => BypassManagerLike | null;
}

// ────────────────────────────────────────────────────────────
// 旁路 agent 编排域工厂
// ────────────────────────────────────────────────────────────

export function createOrchestratorDomain(options: OrchestratorDomainOptions): DomainHandler {
  const { getBypassManager } = options;

  /** 取旁路 manager，不存在时抛错 */
  function requireManager(): BypassManagerLike {
    const manager = getBypassManager();
    if (!manager) throw new Error('bypass manager not available');
    return manager;
  }

  /** 组装当前状态 */
  function snapshot(manager: BypassManagerLike): OrchestratorState {
    return {
      active: manager.isActive('orchestrator'),
      activeAgents: manager.getActiveNames?.() ?? [],
    };
  }

  return {
    // ── orchestrator.get ───────────────────────────────────
    get(): { orchestrator: OrchestratorState } {
      const manager = getBypassManager();
      if (!manager) return { orchestrator: { active: false, activeAgents: [] } };
      return { orchestrator: snapshot(manager) };
    },

    // ── orchestrator.setEnabled ────────────────────────────
    async setEnabled(params: unknown): Promise<{ ok: true; orchestrator: OrchestratorState }> {
      const enabled = (params as { enabled?: boolean } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') {
        throw new Error('orchestrator.setEnabled requires boolean "enabled"');
      }
      const manager = requireManager();
      if (enabled) {
        if (!manager.activateAgent) throw new Error('activateAgent not supported by bypass manager');
        await manager.activateAgent('orchestrator');
      } else {
        if (!manager.deactivateAgent) throw new Error('deactivateAgent not supported by bypass manager');
        await manager.deactivateAgent('orchestrator');
      }
      return { ok: true, orchestrator: snapshot(manager) };
    },
  };
}
