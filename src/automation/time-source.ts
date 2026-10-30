/**
 * AutomationRule 的时间源（2026-10-30，2026-10-31 修热更缓存失效）
 *
 * 前置两步已完成：probe 类靠 watcher、event 类靠 TriggerHub 被动接收。
 * time 类需要**主动计时** —— 本模块就是一个轻量 tick：
 *   每 tickMs 扫一遍所有 time 规则，到点的就派发 `afterTime:<ruleId>` 事件。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么用「schedule 内容签名」缓存，而不是单纯的 ruleId → nextRun
 * ────────────────────────────────────────────────────────────────────────────
 * 2026-10-31 缺陷（审查确认）：旧实现 `nextRun: Map<ruleId, number|null>` 见 id 已存在
 * 就返回旧值。于是：
 *   · fixed-time 规则**触发过一次后** nextRun 被写成 null（已过），此后即使改 runAt
 *     也因 has(id) 命中旧值 ⇒ **永不触发，只能重启进程**解封；
 *   · daily/interval 改配置后仍按旧配置算一次，之后才自愈。
 * 修法：缓存里同时存 schedule 的**内容签名**，配置变了（sig 变）就重算，
 * 无需外部显式 invalidate —— 热更两路（都只重挂 probe watcher、不碰时间源）也能自动生效。
 *
 * 支持 interval / daily / fixed-time / cron；random 仍不支持（有状态，用 scheduler 任务）。
 */

import type { AutomationRule } from './types.js';
import { CronExpression } from '../utils/cron.js';

/** time 类规则里我们支持的调度配置子集 */
interface IntervalCfg { intervalMs: number }
interface DailyCfg { time: string } // "HH:mm"
interface FixedTimeCfg { runAt: string } // ISO 8601
interface CronCfg { expression: string } // 5-field cron

export interface TimeSourceDeps {
  /** 现取当前规则（热更后自动跟上） */
  getRules: () => readonly AutomationRule[];
  /** 到点时派发；由装配层接到 dispatchAutomationEvent */
  fire: (ruleId: string) => void | Promise<void>;
  /** 扫描间隔，默认 5000（与 scheduler 心跳一致） */
  tickMs?: number;
  /** 注入 now 便于测试 */
  now?: () => number;
}

export interface TimeSource {
  start(): void;
  stop(): void;
  /** 供测试/诊断：当前各规则的 nextRunAt */
  snapshot(): Array<{ ruleId: string; nextRunAt: number | null }>;
}

/**
 * 计算下一次触发时刻。
 * @returns null 表示不支持的配置 / 已过期的 fixed-time
 */
export function computeNextRun(
  schedule: Record<string, unknown>,
  from: number,
): number | null {
  // interval：从现在起一个间隔
  if (typeof schedule.intervalMs === 'number' && schedule.intervalMs > 0) {
    return from + schedule.intervalMs;
  }

  // daily：今天的 HH:mm，已过则明天
  if (typeof schedule.time === 'string' && /^\d{1,2}:\d{2}$/.test(schedule.time)) {
    const [hh, mm] = schedule.time.split(':').map(Number);
    const d = new Date(from);
    const target = new Date(d);
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= from) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  // fixed-time：ISO 一次性；已过则不再触发
  if (typeof schedule.runAt === 'string') {
    const t = Date.parse(schedule.runAt);
    if (Number.isNaN(t)) return null;
    return t > from ? t : null;
  }

  // cron：5-field 标准表达式（字段 expression，与 scheduler CronConfig / UI 一致）
  if (typeof schedule.expression === 'string' && schedule.expression.trim()) {
    try {
      const next = new CronExpression(schedule.expression).next(new Date(from));
      return next ? next.getTime() : null;
    } catch {
      return null; // 非法表达式不触发（创建时应由校验拦下）
    }
  }

  return null;
}

export function createTimeSource(deps: TimeSourceDeps): TimeSource {
  const tickMs = deps.tickMs ?? 5000;
  const now = deps.now ?? Date.now;

  /** ruleId → { at: 下次触发时刻; sig: 该时刻对应的 schedule 内容签名 } */
  const nextRun = new Map<string, { at: number | null; sig: string }>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  function sigOf(schedule: Record<string, unknown>): string {
    try {
      return JSON.stringify(schedule);
    } catch {
      return String(schedule);
    }
  }

  /** 按规则当前配置计算 { at, sig } */
  function computeFor(rule: AutomationRule, from: number): { at: number | null; sig: string } {
    if (rule.when.kind !== 'time') return { at: null, sig: '' };
    const schedule = rule.when.schedule;
    return { at: computeNextRun(schedule, from), sig: sigOf(schedule) };
  }

  /**
   * 取该规则的下次触发时刻。
   * · 首次见到 ⇒ 计算并缓存；
   * · 缓存存在且 **schedule 内容签名未变** ⇒ 沿用（不重算，避免每次 tick 抖动）；
   * · 签名变了（热更改了配置）⇒ **重算并覆盖**（这是本次修复的核心）。
   */
  function ensureSchedule(rule: AutomationRule, from: number): number | null {
    const cur = nextRun.get(rule.id);
    const curSig = rule.when.kind === 'time' ? sigOf(rule.when.schedule) : '';
    if (cur && cur.sig === curSig) return cur.at;
    const next = computeFor(rule, from);
    nextRun.set(rule.id, next);
    return next.at;
  }

  async function tick(): Promise<void> {
    if (!running) return;
    const t = now();
    const rules = deps.getRules();

    // 清理已不存在的规则，避免 map 无限增长
    const alive = new Set(rules.map((r) => r.id));
    for (const id of nextRun.keys()) if (!alive.has(id)) nextRun.delete(id);

    for (const rule of rules) {
      if (!rule.enabled || rule.when.kind !== 'time') continue;

      const due = ensureSchedule(rule, t);
      if (due === null) continue;
      if (due > t) continue;

      // 到点：派发
      try {
        await deps.fire(rule.id);
      } catch (err) {
        // 单条规则派发失败不阻断其它规则
        console.error(`[automation] time 规则 "${rule.name}" 派发失败: ${(err as Error).message}`);
      }

      // 重算下一次：fixed-time 只触发一次（computeNextRun 返回 null）
      nextRun.set(rule.id, computeFor(rule, t));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      // 立即登记一次 nextRun（不等第一个 tick）。
      //
      // 为什么：`interval` 的语义是「从 start 那一刻起一个间隔」。若等到第一个 tick
      // 才登记，基准就变成了"首个 tick 的时刻"（可能已过去几秒）⇒ 行为不确定，
      // 且 fixed-time 规则可能在首个 tick 前就已过期而永远不触发。
      const t0 = now();
      for (const rule of deps.getRules()) {
        if (rule.enabled && rule.when.kind === 'time') ensureSchedule(rule, t0);
      }
      timer = setInterval(() => void tick(), tickMs);
      // 不阻止进程退出（自动化不该拖住关闭）
      timer.unref?.();
    },
    stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      nextRun.clear();
    },
    snapshot() {
      return [...nextRun.entries()].map(([ruleId, v]) => ({ ruleId, nextRunAt: v.at }));
    },
  };
}
