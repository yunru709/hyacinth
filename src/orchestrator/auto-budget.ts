/**
 * 自主唤醒的预算闸门（2026-11-02 · P4）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么必须和 tick 同批上线
 * ────────────────────────────────────────────────────────────────────────────
 * 没有闸门的 tick = 装闹钟不装日历：第一个晚上就可能把额度烧穿，而且**是静默的**
 * （没人会在凌晨三点盯着账单）。所以闸门不是"以后优化"，是入场券。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ 「醒 → 做 → 挂起 → 又醒」不是空转，是心跳（2026-11-05 定论）
 * ────────────────────────────────────────────────────────────────────────────
 * 定案里警告「自主循环最容易栽进醒/做/挂起/又醒的空转」，容易被读成"循环本身有病"。
 * **不是。** 判据是**「做」这一环有没有信息增量**，不是循环了几次：
 *
 *   · 挂起期间零模型 —— 等的是 WatchService 的本地采样（file/http/process/port/
 *     ui_region），不起 LLM 回合；`kind:'user'` 甚至不挂任何监控。等待不烧 token。
 *   · 每次醒都要过本文件的闸（perHour / perDay / quietHours），频率天生有界。
 *   · 唤醒 prompt 明确允许「判断不需要行动 ⇒ 继续 suspend」，合法静默是一等公民。
 *
 * 所以「每小时醒来看看、发现没事、继续睡」= 护士巡视 = polling，不是空转。
 *
 * 真正要防的是另外三种，**都不在本文件职责内**：
 *   1. 自激环：动作改了自己监视的条件（写自己 watch 的文件）⇒ probe 每次都真命中，
 *      「无进展检测」抓不到它（变化是真发生了，只是自己制造的），只能靠
 *      「动作写入路径 ∩ 监视路径」另一类判据。
 *   2. 同构重复：每轮都调工具、参数类似、外部世界没变。
 *   3. 为了不空转而制造行动：改两句注释、挪个文件、写份没人要的报告 —— 比安静地睡
 *      **危险得多**，因为留痕、污染外部世界。
 *
 * 反过来说：**把「空转」当敌人会逼出第 3 种。** 任何"连续 N 轮没动作就报警"的围栏
 * 都在惩罚正确行为。正确判据是：**同一状态的重复观测不构成进展；对世界的改变、
 * 或对自身认知的改变，才构成进展。**
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 三道闸，都拦"自己叫自己起床"，不拦用户
 * ────────────────────────────────────────────────────────────────────────────
 *   1. 静默时段（默认 03:00–08:00）—— 这段时间自主活动一律不做。
 *      ⚠️ 只拦**自主**唤醒；用户此刻说话照常响应（那是人叫的，不是自己醒的）。
 *   2. 每小时上限（默认 6 次）
 *   3. 每日上限（默认 100 次）
 *
 * 默认值刻意保守：先跑得起来、看得见成本，再谈放宽。
 * 生效优先级：`~/.agent/auto.json` 的 budgetPerHour/budgetPerDay > 本文件代码默认。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 「每日上限」怎么复位：滑动窗口，不是整点清零
 * ────────────────────────────────────────────────────────────────────────────
 * canWake/record/usage 每次都调 prune()，只保留 24h 内的记录 ⇒ 额度随时间**滚动
 * 回退**，第 N 次唤醒在 24 小时后自动出窗，不需要任何定时器。
 * 为什么不用"整点清零"：那会让 23:59 和 00:01 各跑满一轮，两分钟烧掉两份额度。
 *
 * ⚠️ 计数是**内存态**：进程重启即归零（有意 —— 宁可重启后多给一次机会，也不要把
 *    计数落盘成又一处需要迁移的状态。真正的天级账应落在 token 统计里，另做）。
 *
 * 本文件本身无 IO、无定时器；只有 getGlobalAutoBudget() 第一次构造时会读一次
 * auto.json（走 loadGlobalAuto 的进程级缓存）来取配置上限。
 */

import { loadGlobalAuto } from './auto-global.js';

export interface AutoBudgetConfig {
  /** 每小时最多自主唤醒次数 */
  perHour: number;
  /** 每日最多自主唤醒次数（滚动 24h 窗口） */
  perDay: number;
  /**
   * 静默时段 [start, end)，24 小时制整点。
   * 支持跨零点（如 [23, 8] = 23:00 到次日 08:00）。省略 = 无静默时段。
   */
  quietHours?: [number, number];
}

export const DEFAULT_AUTO_BUDGET: AutoBudgetConfig = {
  perHour: 6,
  // 2026-11-05 孑遗定：30 → 100。心跳式自主（醒来看一眼、没事继续睡）一天百次可接受。
  perDay: 100,
  quietHours: [3, 8],
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 是否处于静默时段（纯函数，便于单测；跨零点也正确处理） */
export function inQuietHours(now: Date, quiet?: [number, number]): boolean {
  if (!quiet) return false;
  const h = now.getHours();
  const [start, end] = quiet;
  if (start === end) return false; // 零长度窗口 = 没有静默
  // 跨零点：h >= 23 || h < 8
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

export type WakeDenialReason = 'quiet_hours' | 'hour_limit' | 'day_limit';

export interface WakeDecision {
  ok: boolean;
  reason?: WakeDenialReason;
  /** 供日志/UI：这一小时 / 今天已用多少 */
  usedThisHour: number;
  usedToday: number;
}

/**
 * 滑动窗口计数器（内存态）。
 *
 * 为什么用滑动窗口而不是"每小时清零"：整点清零会让 59 分和 01 分各跑满一轮，
 * 两分钟内消耗掉两倍额度。滑动窗口没有这个缝隙。
 *
 * 重启后归零（内存态）—— 这是有意的：宁可重启后多给一次机会，
 * 也不要把计数落盘搞成又一处需要迁移的状态。真正的天级账应该落在 token 统计里（另做）。
 */
export class AutoBudgetCounter {
  private stamps: number[] = [];

  constructor(private readonly cfg: AutoBudgetConfig = DEFAULT_AUTO_BUDGET) {}

  /**
   * 当前**生效**的配置。
   *
   * ⚠️ 显示上限（UI / 日志）必须读这里，**不要**再直接读 DEFAULT_AUTO_BUDGET ——
   *    否则 auto.json 覆盖后，UI 显示 30 而实际放行 100（"配置回声"式欺骗）。
   */
  get config(): AutoBudgetConfig {
    return this.cfg;
  }

  /** 现在能不能自主唤醒一次（不记账 —— 记账要等真的唤醒了再调 record） */
  canWake(nowMs: number = Date.now()): WakeDecision {
    this.prune(nowMs);
    const hourAgo = nowMs - HOUR_MS;
    const usedThisHour = this.stamps.filter((t) => t >= hourAgo).length;
    const usedToday = this.stamps.length; // prune 已裁到 24h 内

    if (inQuietHours(new Date(nowMs), this.cfg.quietHours)) {
      return { ok: false, reason: 'quiet_hours', usedThisHour, usedToday };
    }
    if (usedThisHour >= this.cfg.perHour) {
      return { ok: false, reason: 'hour_limit', usedThisHour, usedToday };
    }
    if (usedToday >= this.cfg.perDay) {
      return { ok: false, reason: 'day_limit', usedThisHour, usedToday };
    }
    return { ok: true, usedThisHour, usedToday };
  }

  /** 记一次自主唤醒（必须在真正起回合**之前**调用，否则崩了就漏账） */
  record(nowMs: number = Date.now()): void {
    this.stamps.push(nowMs);
    this.prune(nowMs);
  }

  /** 当前用量（UI/日志用） */
  usage(nowMs: number = Date.now()): { usedThisHour: number; usedToday: number } {
    this.prune(nowMs);
    const hourAgo = nowMs - HOUR_MS;
    return {
      usedThisHour: this.stamps.filter((t) => t >= hourAgo).length,
      usedToday: this.stamps.length,
    };
  }

  /** 只保留 24 小时内的记录（= 「每日上限」的自动复位机制，滚动窗口） */
  private prune(nowMs: number): void {
    const dayAgo = nowMs - DAY_MS;
    if (this.stamps.length === 0) return;
    this.stamps = this.stamps.filter((t) => t >= dayAgo);
  }
}

// ── 进程级单例（2026-11-04 全局化）──────────────────────────────────────────
//
// 为什么共享：预算账是**全局**的。每个会话各记一本账，等于"6 次/小时"实际是
// "6 次/小时 × 会话数"，闸门形同虚设。共享后才是真的"这个进程每小时最多醒 6 次"。
//
// 重启归零（内存态）—— 有意：宁可重启后多给一次机会，也不要把计数搞成
// 又一处需要迁移的持久化状态。真正的天级账应该落在 token 统计里（另做）。

let globalCounter: AutoBudgetCounter | null = null;

/**
 * 取全局预算计数器（进程单例）。
 *
 * ⚠️ 2026-11-05 修：以前这里是 `new AutoBudgetCounter()` 无参 ⇒ `auto.json` 里
 *    解析好的 budgetPerHour / budgetPerDay **从来没被读过**（死字段），用户改配置
 *    不生效。现在按「auto.json 配置 > 代码默认」构造。
 *
 * 注意：配置变更时单例**不会**自动重建 —— 调用方若改了预算，须配 resetGlobalAutoBudget()
 * （见 loop.setAutoMode）。
 */
export function getGlobalAutoBudget(): AutoBudgetCounter {
  if (globalCounter) return globalCounter;
  const g = loadGlobalAuto();
  globalCounter = new AutoBudgetCounter({
    perHour: g.budgetPerHour ?? DEFAULT_AUTO_BUDGET.perHour,
    perDay: g.budgetPerDay ?? DEFAULT_AUTO_BUDGET.perDay,
    quietHours: DEFAULT_AUTO_BUDGET.quietHours,
  });
  return globalCounter;
}

/** 测试用 / 配置变更后：重置单例（计数也归零） */
export function resetGlobalAutoBudget(): void {
  globalCounter = null;
}
