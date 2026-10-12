// ============================================================
// goal 模式 —— 「不达成目标不退出 LOOP」的出口改造
// ============================================================
// 定位（2026-10-10 用户定稿）：**只改 loop 的出口**。默认出口是 end_turn（模型不再调
// 工具即结束）；goal 模式把它废掉，唯一出口是 finish_goal —— 而 finish_goal 必须先过
// 一道「审查子 agent」（对抗式验收官）。
//
// 三块职责，本文件只放**可测的纯逻辑 + 落盘**（不碰 loop 实例）：
//   ① 状态：GoalState（session 级，落 <sessionDir>/goal.json，跨 restart 存活）
//   ② 工具管制：goal 生效时禁掉「换环境 / 宣布完成」两类工具；finish_goal 强制可见
//   ③ 出口闸门：decideGoalGate() —— 未达成而想停 → 拽回来继续（带预算兜底）
//
// 接线（loop.ts）：
//   - 每轮 finalize 之后调 decideGoalGate；'stop=false' → 注入消息 + 继续
//   - 装配侧（stages/context.ts）与执行侧（makeToolExecContext）**共用同一张黑名单**
//     —— 两处不同序就会重演「看得见、调不通」（2026-10-10 陪伴工具已踩过一次）
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

/** goal 状态（session 级；进入时锁定 objective，达成或解除后清空） */
export interface GoalState {
  active: boolean;
  /** 目标原文 —— 审查官判「达成没有」的标尺（进入时固定，中途不改） */
  objective: string;
  /** 由谁进入：用户 /goal，或 agent 应用户要求调 enter_goal */
  enteredBy: 'user' | 'agent';
  enteredAt: string;
  /** finish_goal 提交审查的次数 */
  reviewAttempts: number;
  /** 被强制续跑（拽回）的次数 */
  nudges: number;
  /** 最近一次审查不通过的理由（喂回主 agent 用） */
  lastRejection?: string;
}

/** 预算（触顶即放行退出并大声告知 —— 不允许把 agent 永久锁死） */
export interface GoalBudget {
  maxNudges: number;
  maxReviews: number;
}

export const DEFAULT_GOAL_BUDGET: GoalBudget = { maxNudges: 40, maxReviews: 10 };

/**
 * goal 生效时**禁用**的工具：一切「能换环境 / 能宣布完成」的。
 * 判据（用户 2026-10-10）：对完成任务没有帮助的自我管理动作，关了。
 *
 * 保留：add_task / interrupt / restart / ask_user / trigger_compression /
 *       activate_bundle / deactivate_bundle / list_bundles / flow_* / rollback* / plan_execute /
 *       一切干活工具。（restart 尤其要留 —— 自我递归改进要靠它加载新 dist。）
 */
export const GOAL_FORBIDDEN_TOOLS: readonly string[] = [
  // ── 宣布完成 / 结束回合（say 禁掉后，交付改由 finish_goal 承担）──
  'say',
  'send_channel_message',
  // ── 换模式（换模式 = 逃逸出 goal）──
  'switch_mode', 'companion_mode', 'reset_companion_session', 'companion_say',
  // ── 换会话（换会话 = 逃逸出 goal）──
  'new_session', 'switch_session', 'delete_session', 'session_fork',
  // ── 改配置 / 换 provider / 通道写 ──
  'update_config', 'reset_config', 'switch_provider', 'switch_to_auto_route',
  'add_model_channel', 'remove_model_channel', 'set_channel_role',
  'set_channel_model', 'reset_channel_model',
  // ── 能力开关 / 权限 ──
  'toggle_tool', 'toggle_skill', 'toggle_sub_agent',
  'allow_tool', 'disallow_tool',
  // ── 工具包**写**操作（activate/deactivate 仍放开 —— 取工具是干活）──
  'create_bundle', 'add_to_bundle', 'remove_from_bundle', 'delete_bundle',
];

const GOAL_FORBIDDEN_SET = new Set(GOAL_FORBIDDEN_TOOLS);

/** goal 生效时**强制可见**的工具（不论激活了哪个包）—— 否则「进得去、出不来」 */
export const GOAL_FORCED_VISIBLE_TOOLS: readonly string[] = ['finish_goal', 'exit_goal'];

export function isToolForbiddenInGoal(name: string): boolean {
  return GOAL_FORBIDDEN_SET.has(name);
}

export function isToolForcedVisibleInGoal(name: string): boolean {
  return GOAL_FORCED_VISIBLE_TOOLS.includes(name);
}

// ── 落盘（<sessionDir>/goal.json；跨 restart 存活，支持自我递归改进） ──────────

export function goalStatePath(sessionDir: string): string {
  return path.join(sessionDir, 'goal.json');
}

/** 读回 goal 状态；文件不存在 / 已解除 / 结构损坏 → null */
export function loadGoalState(sessionDir: string): GoalState | null {
  try {
    const raw = fs.readFileSync(goalStatePath(sessionDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GoalState>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.active !== true) return null;
    if (typeof parsed.objective !== 'string' || !parsed.objective) return null;
    return {
      active: true,
      objective: parsed.objective,
      enteredBy: parsed.enteredBy === 'user' ? 'user' : 'agent',
      enteredAt: typeof parsed.enteredAt === 'string' ? parsed.enteredAt : new Date().toISOString(),
      reviewAttempts: Number.isFinite(parsed.reviewAttempts) ? (parsed.reviewAttempts as number) : 0,
      nudges: Number.isFinite(parsed.nudges) ? (parsed.nudges as number) : 0,
      lastRejection: typeof parsed.lastRejection === 'string' ? parsed.lastRejection : undefined,
    };
  } catch {
    return null;
  }
}

/** 落盘（尽力而为；失败不阻塞主流程）。state 为空或已解除 → 删除文件 */
export function saveGoalState(sessionDir: string, state: GoalState | null): void {
  try {
    if (!state || !state.active) {
      fs.rmSync(goalStatePath(sessionDir), { force: true });
      return;
    }
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(goalStatePath(sessionDir), JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    /* 落盘失败不影响本次运行 */
  }
}

// ── 出口闸门（纯函数） ────────────────────────────────────────────────────────

export interface GoalGateDecision {
  stop: boolean;
  stopReason?: string;
  /** 需注入给主 agent 的续跑 / 告警消息（无需注入则 null） */
  message: string | null;
  /** 是否触发告警级 UI 提示 */
  warn: boolean;
}

export const GOAL_PENDING_REASON = 'goal_pending';
export const GOAL_ACHIEVED_REASON = 'goal_achieved';
export const GOAL_BUDGET_EXCEEDED_REASON = 'goal_budget_exceeded';

/**
 * goal 出口闸门（纯函数）——
 *   - 未激活 / 已 goal_achieved / 本轮本来就继续 → 原样放行
 *   - 激活且想停：预算未触顶 → 拽回继续（stop=false）；触顶 → 放行但标 goal_budget_exceeded
 * 调用方负责副作用：追加 message、累加 nudges。
 */
export function decideGoalGate(
  stop: boolean,
  stopReason: string | undefined,
  state: GoalState | null,
  budget: GoalBudget = DEFAULT_GOAL_BUDGET,
): GoalGateDecision {
  if (!state?.active) return { stop, stopReason, message: null, warn: false };
  if (stopReason === GOAL_ACHIEVED_REASON) return { stop, stopReason, message: null, warn: false };
  if (!stop) return { stop, stopReason, message: null, warn: false };

  if (state.nudges >= budget.maxNudges || state.reviewAttempts >= budget.maxReviews) {
    return {
      stop: true,
      stopReason: GOAL_BUDGET_EXCEEDED_REASON,
      message:
        `[Goal] 预算触顶（续跑 ${state.nudges}/${budget.maxNudges}、审查 ${state.reviewAttempts}/${budget.maxReviews}）。` +
        `目标「${state.objective}」仍未通过验收，goal 模式已解除。请向用户如实说明当前进度与卡点。`,
      warn: true,
    };
  }

  return {
    stop: false,
    stopReason: GOAL_PENDING_REASON,
    message:
      `[Goal] 目标尚未达成：「${state.objective}」。\n` +
      '不要结束回合。继续工作；确认达成后调用 finish_goal，提交 evidence（**可核验**的证据：命令+输出 / 文件路径 / 测试结果）' +
      '与 conclusion（结论）。' +
      (state.lastRejection ? `\n上次审查不通过的理由：${state.lastRejection}` : ''),
    warn: true,
  };
}

/** 构造一个新的 GoalState（进入时用） */
export function createGoalState(objective: string, by: 'user' | 'agent'): GoalState {
  return {
    active: true,
    objective: objective.trim(),
    enteredBy: by,
    enteredAt: new Date().toISOString(),
    reviewAttempts: 0,
    nudges: 0,
  };
}

// ── 审查官契约（loop ⇄ 装配方注入的 reviewer 实现） ────────────────────────────

/** 审查官请求：目标（标尺）+ 主 agent 提交的原料（证据 / 结论） */
export interface GoalReviewRequest {
  objective: string;
  evidence: string;
  conclusion: string;
  /** 第几次提交（从 1 起）—— 实现方可据此换新 instanceId，保证审查官「每轮全新」 */
  attempt: number;
}

/** 审查结论：pass / fail / unavailable（服务不可用 → 重试后退出并标注未核验） */
export interface GoalReviewResult {
  verdict: 'pass' | 'fail' | 'unavailable';
  /** pass / fail 的理由；unavailable 时为错误信息 */
  reason: string;
  /**
   * 审查官是否确认「目标已达成」（机器可断言的硬门）。
   *
   * 2026-10-10 实测缺陷：审查官原判据是「证据是否支持结论」，于是提交一份**诚实的负面报告**
   * （"目标没有达成，本轮价值是…"）也能过 —— 因为证据确实支持那个结论 ⇒ 出口被绕过。
   * 现在 loop.submitGoal 侧强制要求 `verdict==='pass' && objectiveAchieved===true` 才放行；
   * 缺失 / 非 true 一律按不通过处理（保守）。
   */
  objectiveAchieved?: boolean;
}

// ── 装配侧工具过滤（context 阶段消费；与执行侧 loop.makeToolExecContext 同源）────

/** goal 工具过滤器：goal 未激活时原样返回；激活时收敛「换环境 / 宣布完成」类并强制可见出口工具 */
export type GoalToolFilter = (
  defs: import('../types.js').ToolDefinition[],
) => import('../types.js').ToolDefinition[];
