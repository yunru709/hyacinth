// ============================================================
// UI 协议层 — 模式域（mode.*）
// ============================================================
// 覆盖「这个会话按什么规则干活」的两组开关：
//   mode.get         读当前执行档位 + goal 状态
//   mode.setProfile  切换执行档位（plan / confirm / auto / full）
//   mode.enterGoal   进入 goal 模式（不达成目标不结束回合）
//   mode.exitGoal    解除 goal 模式
//
// 为什么单独成域而不塞进 permission：
//   permission.* 是**请求-应答**通道（弹条 → 等用户按按钮 → resolve），语义是"这一次调用准不准"；
//   模式是**会话级状态**（长期生效、可在没有待决请求时随时改）。两者生命周期完全不同，
//   合在一起会让"待决请求"与"当前策略"两个概念混在同一个域里。
//
// 与 TUI 的关系：/goal 与 AOR 的 TUI 路径走同一批 loop 方法（enterGoal/exitGoal/
// setPermissionProfile），所以两边不会出现"TUI 改了 WebUI 不认"的分叉。
// ============================================================

import type { DomainHandler } from '../server.js';
import {
  normalizePermissionProfile,
  type PermissionProfile,
} from '../../orchestrator/permission-profile.js';

/** goal 状态快照（只暴露 UI 需要的字段，不含审查内部细节） */
export interface GoalStateView {
  active: boolean;
  objective: string;
  enteredBy: 'user' | 'agent';
  enteredAt: string;
  reviewAttempts: number;
  nudges: number;
  lastRejection?: string;
}

/** mode 域依赖的 loop 能力（结构类型，避免把 AgentLoop 整个拖进协议层） */
export interface ModeLoopLike {
  getPermissionProfile?(): PermissionProfile;
  setPermissionProfile?(profile: PermissionProfile): PermissionProfile;
  getGoalState?(): GoalStateView | null;
  enterGoal?(
    objective: string,
    by: 'user' | 'agent',
  ): { ok: true; note: string } | { ok: false; error: string };
  exitGoal?(reason: string): boolean;
}

export interface ModeDomainOptions {
  /** 延迟解析：loop 在 UiProtocolSession.initialize 之后才就绪 */
  getLoop: () => ModeLoopLike | null;
}

export interface ModeSnapshot {
  profile: PermissionProfile;
  /** profile === 'full' 的派生值（保留给还没改读 profile 的旧代码） */
  unrestricted: boolean;
  goal: GoalStateView | null;
}

export function createModeDomain(options: ModeDomainOptions): DomainHandler {
  const { getLoop } = options;

  const loopOrThrow = (): ModeLoopLike => {
    const loop = getLoop();
    if (!loop) throw new Error('mode: agent loop is not ready yet');
    return loop;
  };

  const snapshot = (loop: ModeLoopLike): ModeSnapshot => {
    const profile = loop.getPermissionProfile?.() ?? 'confirm';
    const goal = loop.getGoalState?.() ?? null;
    return {
      profile,
      unrestricted: profile === 'full',
      goal: goal ? { ...goal } : null,
    };
  };

  return {
    // ── mode.get ───────────────────────────────────────────
    get: (): ModeSnapshot => snapshot(loopOrThrow()),

    // ── mode.setProfile ────────────────────────────────────
    /** 非法档位直接抛（协议层包成 error）—— 不静默回默认，否则 UI 会以为切成功了 */
    setProfile: (params: unknown): ModeSnapshot => {
      const { profile } = (params ?? {}) as { profile?: unknown };
      const next = normalizePermissionProfile(profile);
      if (next !== profile) {
        throw new Error(
          `mode.setProfile requires "profile" ∈ (plan|confirm|auto|full), got ${JSON.stringify(profile)}`,
        );
      }
      const loop = loopOrThrow();
      if (!loop.setPermissionProfile) throw new Error('mode.setProfile: loop does not support profiles');
      loop.setPermissionProfile(next);
      return snapshot(loop);
    },

    // ── mode.enterGoal ─────────────────────────────────────
    /**
     * 进入 goal 模式。失败（空目标 / 已在 goal 中）返回 `{ok:false,error}` 而不是抛错：
     * 这是**用户输入问题**，UI 要拿原文案贴在自己菜单里，不该变成一条协议错误。
     */
    enterGoal: (params: unknown): { ok: boolean; note?: string; error?: string } => {
      const { objective } = (params ?? {}) as { objective?: unknown };
      const loop = loopOrThrow();
      if (!loop.enterGoal) throw new Error('mode.enterGoal: loop does not support goal mode');
      const r = loop.enterGoal(typeof objective === 'string' ? objective : '', 'user');
      return r.ok ? { ok: true, note: r.note } : { ok: false, error: r.error };
    },

    // ── mode.exitGoal ──────────────────────────────────────
    exitGoal: (params: unknown): { ok: boolean; reason?: string } => {
      const { reason } = (params ?? {}) as { reason?: unknown };
      const loop = loopOrThrow();
      if (!loop.exitGoal) throw new Error('mode.exitGoal: loop does not support goal mode');
      const why = typeof reason === 'string' && reason.trim() ? reason.trim() : '用户手动解除';
      return { ok: loop.exitGoal(why), reason: why };
    },
  };
}
