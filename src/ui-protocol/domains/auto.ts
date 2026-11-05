// ============================================================
// UI 契约层 — 自主模式域（auto.*）
// ============================================================
// 2026-11-02。自主模式（"出口即入口"）的 UI 面。
//
// 【为什么先只给契约 + stub】
//   后端的三块（P2 suspend 出口 / P3 触发表持久化 / P4 tick 唤醒）都还没落地，
//   但 UI 侧（webui 的 .mode-auto 卡片 + 常驻徽标、TUI 的 /auto 命令）可以先做。
//   只要这一层的**形状**定死，两边就能并行 —— 后端落地时换掉 controller 实现即可，
//   域代码与前端一行都不用动。
//
// 【契约要点（与设计稿一致，改动前先看这里）】
//   1. phase 四态严格区分：
//        off       没开
//        running   正在跑回合
//        suspended 睡着，等某个条件
//        silent    睡着，且只等用户说话（"合法静默"，不烧钱）
//      ⚠️ silent 必须单列。用户最关心"它现在会不会自己动/会不会花钱"，
//         把它和 suspended 合并成一个"休眠"就答不了这个问题。
//   2. lastWake 必须带：这是判断"它是不是在瞎转"的唯一线索。
//   3. budget 双窗口（每小时 + 每日）：防一夜之间烧穿。
// ============================================================

import type { DomainHandler } from '../server.js';

/** 自主模式阶段 */
export type AutoPhase = 'off' | 'running' | 'suspended' | 'silent';

/** 触发表里的一条（UI 只读展示 + 可单独删除） */
export interface AutoTriggerView {
  id: string;
  /** 入口类型（与 TriggerProvider.kind 同源：file / ui_region / http / process / port / time / audio…） */
  kind: string;
  /** 人话描述，UI 直接显示（"VSCode 窗口画面变化"） */
  note?: string;
  cooldownMs?: number;
  armedAt?: string;
}

/** UI 侧只读的状态快照（AutoState 的视图层，不含内部字段） */
export interface AutoStateView {
  phase: AutoPhase;
  /** 进入当前 phase 的时刻 */
  since: string;
  /** 挂起时：在等什么 */
  until?: { kind: string; note?: string };
  /** 定时类条件的预计唤醒时刻（ISO）；非定时条件为 undefined */
  nextWakeAt?: string;
  budget: {
    usedThisHour: number;
    limitThisHour: number;
    usedToday: number;
    limitToday: number;
  };
  armed: AutoTriggerView[];
  /** 上一轮为什么被唤醒 */
  lastWake?: { at: string; reason: string };
}

/**
 * 控制器接口 —— 域只认这个，不认识 loop / scheduler / trigger。
 * P4 落地时由装配层注入真实实现；在此之前用下面的 stub。
 */
export interface AutoControllerLike {
  status(): AutoStateView;
  setEnabled(
    enabled: boolean,
    budget?: { perHour?: number; perDay?: number },
  ): Promise<AutoStateView>;
  /** 急停：立刻停 loop 并清空触发表（与 setEnabled(false) 的区别在于"不保留还是保留"） */
  stop(): Promise<AutoStateView>;
  setBudget(budget: { perHour?: number; perDay?: number }): Promise<AutoStateView>;
  removeTrigger(id: string): Promise<AutoStateView>;
}

export interface AutoDomainOptions {
  /** 真实控制器；省略 = 用内存 stub（后端未落地时的默认，供 UI 联调） */
  controller?: AutoControllerLike;
  /** 每轮成功/失败后重新取（P4 之后可能按会话取不同实例） */
  getController?: () => AutoControllerLike | null;
}

// ────────────────────────────────────────────────────────────
// 内存 stub —— 让 UI 现在就能联调
// ────────────────────────────────────────────────────────────

const DEFAULT_LIMIT_PER_HOUR = 6;
const DEFAULT_LIMIT_PER_DAY = 30;

/**
 * 内存实现：只记住开关和预算，**不会真的唤醒任何东西**。
 *
 * 存在的意义：前端不是对着空气写代码 —— 点"开启"能立刻看到 badge 变、
 * 预算能改、解除能回 off。等 P4 把真实控制器接上，前端不用改。
 */
export function createStubAutoController(): AutoControllerLike {
  const state: AutoStateView = {
    phase: 'off',
    since: new Date().toISOString(),
    budget: {
      usedThisHour: 0,
      limitThisHour: DEFAULT_LIMIT_PER_HOUR,
      usedToday: 0,
      limitToday: DEFAULT_LIMIT_PER_DAY,
    },
    armed: [],
  };

  /** 状态不变则不改 since（避免 UI 的"已运行 3 分钟"被无意义刷新） */
  const setPhase = (phase: AutoPhase): void => {
    if (state.phase === phase) return;
    state.phase = phase;
    state.since = new Date().toISOString();
    if (phase !== 'suspended') {
      state.until = undefined;
      state.nextWakeAt = undefined;
    }
  };

  return {
    status: () => structuredClone(state),

    async setEnabled(enabled, budget) {
      if (budget?.perHour !== undefined) state.budget.limitThisHour = budget.perHour;
      if (budget?.perDay !== undefined) state.budget.limitToday = budget.perDay;
      // 开启 → silent（没有触发表时，最诚实的相位就是"只等用户说话"）
      setPhase(enabled ? 'silent' : 'off');
      return structuredClone(state);
    },

    async stop() {
      state.armed = [];
      setPhase('off');
      return structuredClone(state);
    },

    async setBudget(budget) {
      if (budget.perHour !== undefined) state.budget.limitThisHour = budget.perHour;
      if (budget.perDay !== undefined) state.budget.limitToday = budget.perDay;
      return structuredClone(state);
    },

    async removeTrigger(id) {
      state.armed = state.armed.filter((t) => t.id !== id);
      return structuredClone(state);
    },
  };
}

// ────────────────────────────────────────────────────────────
// 域工厂
// ────────────────────────────────────────────────────────────

export function createAutoDomain(options: AutoDomainOptions = {}): DomainHandler {
  const stub = options.controller ?? (options.getController ? null : createStubAutoController());
  const resolve = (): AutoControllerLike => {
    const c = options.getController?.() ?? stub;
    if (!c) throw new Error('auto controller not available');
    return c;
  };

  return {
    // ── auto.status ────────────────────────────────────────
    status(): { auto: AutoStateView } {
      const c = options.getController?.() ?? stub;
      // 控制器尚未装配时不要抛错：UI 打开设置面板属于"看一眼"，不是操作
      if (!c) return { auto: emptyAutoState() };
      return { auto: c.status() };
    },

    // ── auto.setEnabled ────────────────────────────────────
    async setEnabled(params: unknown): Promise<{ ok: true; auto: AutoStateView }> {
      const p = params as
        | { enabled?: boolean; budgetPerHour?: number; budgetPerDay?: number }
        | undefined;
      if (typeof p?.enabled !== 'boolean') {
        throw new Error('auto.setEnabled requires boolean "enabled"');
      }
      const auto = await resolve().setEnabled(p.enabled, {
        perHour: p.budgetPerHour,
        perDay: p.budgetPerDay,
      });
      return { ok: true, auto };
    },

    // ── auto.stop（急停）────────────────────────────────────
    async stop(): Promise<{ ok: true; auto: AutoStateView }> {
      return { ok: true, auto: await resolve().stop() };
    },

    // ── auto.setBudget ─────────────────────────────────────
    async setBudget(params: unknown): Promise<{ ok: true; auto: AutoStateView }> {
      const p = params as { perHour?: number; perDay?: number } | undefined;
      if (p?.perHour === undefined && p?.perDay === undefined) {
        throw new Error('auto.setBudget requires "perHour" and/or "perDay"');
      }
      return { ok: true, auto: await resolve().setBudget({ perHour: p.perHour, perDay: p.perDay }) };
    },

    // ── auto.removeTrigger ─────────────────────────────────
    async removeTrigger(params: unknown): Promise<{ ok: true; auto: AutoStateView }> {
      const id = (params as { id?: string } | undefined)?.id;
      if (!id) throw new Error('auto.removeTrigger requires "id"');
      return { ok: true, auto: await resolve().removeTrigger(id) };
    },
  };
}

/** 控制器未装配时的空状态（UI 不应因后端未就绪而白屏） */
function emptyAutoState(): AutoStateView {
  return {
    phase: 'off',
    since: new Date(0).toISOString(),
    budget: {
      usedThisHour: 0,
      limitThisHour: DEFAULT_LIMIT_PER_HOUR,
      usedToday: 0,
      limitToday: DEFAULT_LIMIT_PER_DAY,
    },
    armed: [],
  };
}

// ── 真实控制器：把 loop 的自主模式接到 UI 域上（2026-11-04）──────────────
//
// 之前用的是 createStubAutoController：它只改内存里的 phase，**不影响 loop** ——
// 那时 UI 是"撒谎的"（开关看着开了，实际什么都没变）。
// 这里把它接上：点 brand ⇒ exit.json 落盘 ⇒ end_turn 被拦 ⇒ 唯一出口变成 suspend。

/**
 * loop 侧的结构化接口。
 *
 * 为什么不直接 import AgentLoop：`ui-protocol` 不该反向依赖 `orchestrator`
 * （与 orchestrator 域用 BypassManagerLike 是同一手法，也是 verify:layers 的要求）。
 */
export interface AutoLoopLike {
  setAutoMode(enabled: boolean): boolean;
  isAutoModeEnabled(): boolean;
  /**
   * 运行期改自主唤醒的预算上限（2026-11-05 补）。
   *
   * 可选：老 loop 没有它时，controller 的 setBudget 会明确报错而不是假装成功
   * （2026-11-05 之前这里就是"假装成功"——TUI `/auto budget` 显示成功但数字没变）。
   */
  setAutoBudget?(budget: { perHour?: number; perDay?: number }): boolean;
  getAutoSnapshot(): {
    phase: 'off' | 'running' | 'suspended' | 'silent';
    since: string;
    budget: { usedThisHour: number; limitThisHour: number; usedToday: number; limitToday: number };
    armed: Array<{ id: string; kind: string; note?: string }>;
  };
}

export function createLoopAutoController(getLoop: () => AutoLoopLike | null): AutoControllerLike {
  const need = (): AutoLoopLike => {
    const loop = getLoop();
    if (!loop) throw new Error('auto: loop 未就绪');
    return loop;
  };
  // loop 的快照结构是 AutoStateView 的子集（缺 until/nextWakeAt/lastWake），
  // 直接收窄断言；反过来若将来 loop 加了新字段，这里不会静默丢。
  const view = (): AutoStateView => need().getAutoSnapshot() as AutoStateView;

  return {
    status(): AutoStateView {
      const loop = getLoop();
      // 未就绪时给 off 而不是抛错 —— "打开设置看一眼"不该白屏
      return loop ? (loop.getAutoSnapshot() as AutoStateView) : emptyAutoState();
    },
    async setEnabled(enabled: boolean): Promise<AutoStateView> {
      need().setAutoMode(enabled);
      return view();
    },
    async stop(): Promise<AutoStateView> {
      // 急停 = 关自主模式（会一并清掉挂起定时器，见 loop.setAutoMode）
      need().setAutoMode(false);
      return view();
    },
    async setBudget(budget: { perHour?: number; perDay?: number }): Promise<AutoStateView> {
      const loop = need();
      if (typeof loop.setAutoBudget !== 'function') {
        // 不要假装成功。2026-11-05 之前这里就是空实现：TUI `/auto budget` 显示成功，
        // 但上限一个数字都没变（协议有、前端有入口、后端空转 —— 典型的"没打通"）。
        // 现在宁可抛错，让调用方知道没接上，也不要再撒谎。
        throw new Error('auto.setBudget: 当前 loop 不支持运行期改预算');
      }
      loop.setAutoBudget({ perHour: budget.perHour, perDay: budget.perDay });
      return view();
    },
    async removeTrigger(): Promise<AutoStateView> {
      // 触发表尚未持久化（armed 恒为空数组），P5 入口注册表落地后再做
      return view();
    },
  };
}
