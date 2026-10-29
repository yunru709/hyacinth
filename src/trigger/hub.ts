/**
 * TriggerHub —— 触发事件总线（2026-10-29）
 *
 * 职责很窄，刻意保持：
 *   1. 收事件（源调 fire）
 *   2. 扇出给所有 sink（异常隔离：一个坏了不影响别的）
 *   3. 留一小段历史 + 统计（诊断"谁在疯狂触发"）
 *
 * 不做的事：不决定"要不要触发"（那是源的事），不决定"触发后干什么"（那是 sink 的事）。
 * 保持这个边界，将来加源/加消费方都不用改这里。
 */

import type { TriggerEvent, TriggerSink, TriggerStats } from './types.js';

const DEFAULT_HISTORY_LIMIT = 100;

export interface TriggerHubOptions {
  /** 保留最近多少条事件（默认 100） */
  historyLimit?: number;
  clock?: () => number;
  /** sink 抛异常时的回调（默认 console.error） */
  onSinkError?: (err: unknown, event: TriggerEvent) => void;
}

export class TriggerHub {
  private sinks: TriggerSink[] = [];
  private history: TriggerEvent[] = [];
  private stats: TriggerStats = { total: 0, bySource: {}, lastAt: null };
  private readonly historyLimit: number;
  private readonly now: () => number;
  private readonly onSinkError: (err: unknown, event: TriggerEvent) => void;

  constructor(opts: TriggerHubOptions = {}) {
    this.historyLimit = Math.max(1, opts.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.now = opts.clock ?? (() => Date.now());
    this.onSinkError =
      opts.onSinkError ??
      ((err, event) => {
        // 不让 sink 的异常冒泡到事件源（否则一次通知失败会拖垮定时器/监控）
        console.error(`[trigger] sink failed for ${event.source}:${event.name}`, err);
      });
  }

  /** 注册消费方，返回取消注册函数 */
  registerSink(sink: TriggerSink): () => void {
    this.sinks.push(sink);
    return () => {
      const i = this.sinks.indexOf(sink);
      if (i >= 0) this.sinks.splice(i, 1);
    };
  }

  /**
   * 发出一个触发事件。
   * - at 缺省填当前时间
   * - 逐个调用 sink；**串行 await**，保证顺序可预测（并发扇出会让"先唤醒再记日志"乱序）
   * - 任一 sink 抛错只记录，不影响其余
   */
  async fire(event: Omit<TriggerEvent, 'at'> & { at?: number }): Promise<void> {
    const full: TriggerEvent = { ...event, at: event.at ?? this.now() };

    this.stats.total += 1;
    this.stats.bySource[full.source] = (this.stats.bySource[full.source] ?? 0) + 1;
    this.stats.lastAt = full.at;

    this.history.push(full);
    if (this.history.length > this.historyLimit) this.history.shift();

    for (const sink of [...this.sinks]) {
      try {
        await sink(full);
      } catch (err) {
        this.onSinkError(err, full);
      }
    }
  }

  /** 最近事件（旧→新） */
  recent(limit = 10): TriggerEvent[] {
    const n = Math.max(1, Math.min(this.historyLimit, limit));
    return this.history.slice(-n);
  }

  statsSnapshot(): TriggerStats {
    return { ...this.stats, bySource: { ...this.stats.bySource } };
  }

  /** sink 数量（诊断用） */
  sinkCount(): number {
    return this.sinks.length;
  }

  /** 清空 sink 与历史（测试/关停用） */
  reset(): void {
    this.sinks = [];
    this.history = [];
    this.stats = { total: 0, bySource: {}, lastAt: null };
  }
}

// ── 进程级单例 ────────────────────────────────────────────────────
// 与 setSchedulerSessionPort 同样的取舍：源分散在 schedule / watch 各处，
// 穿透多层依赖注入会很脏，且 agent-assembly 是按会话多次创建的，重复注入会冲突。
let globalHub: TriggerHub | null = null;

export function setGlobalTriggerHub(hub: TriggerHub | null): void {
  globalHub = hub;
}

/**
 * 取全局总线。没有注册时返回 null（**不自动创建**）——
 * 自动创建会让"忘记接线"变成"静默有个没人消费的总线"，反而更难发现。
 */
export function getGlobalTriggerHub(): TriggerHub | null {
  return globalHub;
}
