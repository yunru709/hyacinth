/**
 * AutomationRule 的时间源（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 补上 when.kind === 'time' 的执行能力
 * ────────────────────────────────────────────────────────────────────────────
 * 前置两步已完成：probe 类靠 watcher、event 类靠 TriggerHub 被动接收。
 * time 类需要**主动计时** —— 本模块就是一个轻量 tick：
 *   每 intervalMs 扫一遍所有 time 规则，到点的就派发 `afterTime:<ruleId>` 事件。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么不复用 Scheduler
 * ────────────────────────────────────────────────────────────────────────────
 * Scheduler 的存储是 tasks.json（带 runCount/nextRunAt/periodStartAt 等运行时状态
 * 与完整的执行记录），语义是"任务"；AutomationRule 是"链路定义"，纯配置。
 * 硬塞进去会让"改配置"和"改统计"互相冲掉，且 diff 不可读。
 *
 * 所以这里**只支持确定性的三种**调度（interval / daily / fixed-time），
 * 覆盖绝大多数需求，且无状态（nextRunAt 在内存里，重启重算）。
 *
 * cron 与 random 暂不支持：
 *   · random 是**有状态**的（periodStartAt / pendingSlots 要持久化跨重启续用）
 *   · cron 需要解析器
 * 需要这两者时，仍可用现有的 scheduler 任务表达 —— 能力等价，只是入口不同。
 *
 * ⚠️ 这是一个**临时的第三条路径**。架构终态是"所有触发源统一为 Source"，
 *    届时本模块会退化成 TimeSource 的一个实现，被 Hub 统一调度。
 */

import type { AutomationRule } from './types.js';

/** time 类规则里我们支持的调度配置子集 */
interface IntervalCfg {
  intervalMs: number;
}
interface DailyCfg {
  time: string; // "HH:mm"
}
interface FixedTimeCfg {
  runAt: string; // ISO 8601
}

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

  return null;
}

export function createTimeSource(deps: TimeSourceDeps): TimeSource {
  const tickMs = deps.tickMs ?? 5000;
  const now = deps.now ?? Date.now;

  /** ruleId → 下次触发时刻（内存态；重启后按当前时间重算） */
  const nextRun = new Map<string, number | null>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  /** 初始化某规则的下次触发时刻（仅在首次见到该规则时算） */
  function ensureSchedule(rule: AutomationRule, from: number): number | null {
    if (nextRun.has(rule.id)) return nextRun.get(rule.id) ?? null;
    const n =
      rule.when.kind === 'time' ? computeNextRun(rule.when.schedule, from) : null;
    nextRun.set(rule.id, n);
    return n;
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

      let due = ensureSchedule(rule, t);
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
      due = computeNextRun(rule.when.schedule, t);
      nextRun.set(rule.id, due);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
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
      return [...nextRun.entries()].map(([ruleId, nextRunAt]) => ({ ruleId, nextRunAt }));
    },
  };
}
