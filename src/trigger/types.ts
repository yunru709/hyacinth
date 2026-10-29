/**
 * Trigger 基础层类型（2026-10-29）
 *
 * 目标：把"什么时候该干活"从**时间专用**泛化成**任意事件源**，
 * 而"干活"（唤醒会话跑一轮）保持单一出口。
 *
 * 分层：本目录是基础层，**不依赖** schedule / watch / orchestrator / gateway。
 * 上下游关系：
 *
 *     HeartbeatScheduler ─┐
 *     WatchService       ─┼──► TriggerHub ──► sink（唤醒会话 / 记日志 / 统计）
 *     未来：webhook…     ─┘
 *
 * 为什么用"总线"而不是让各源自己调唤醒：
 * 事件需要统一去抖、限流、观察（谁在什么时候触发了什么）。分散在各源里，
 * 一出问题就要满仓库找；有了总线，加个 sink 就能统一观测。
 */

/** 一次触发 */
export interface TriggerEvent {
  /** 事件源标识：'schedule' | 'watch' | <自定义> */
  source: string;
  /** 事件名（定时任务名 / 监控项摘要） */
  name: string;
  /** 发生时刻（ms） */
  at: number;
  /** 附加信息，由源自定义（如 watch 的 kind/distance/owner） */
  detail?: Record<string, unknown>;
}

/** 事件消费方。抛异常不影响其它 sink，也不影响事件源。 */
export type TriggerSink = (event: TriggerEvent) => void | Promise<void>;

/**
 * 事件源。实现者负责"在合适的时候调 hub.fire()"，
 * 不关心谁消费、消费成什么。
 */
export interface TriggerSource {
  /** 源标识，与 TriggerEvent.source 一致 */
  readonly id: string;
  /** 人类可读描述 */
  readonly description: string;
  /** 启动（注册到 hub 之后调用） */
  start(): void | Promise<void>;
  /** 停止，释放定时器/监听器 */
  stop(): void | Promise<void>;
}

/** 总线统计，便于诊断"谁在疯狂触发" */
export interface TriggerStats {
  total: number;
  bySource: Record<string, number>;
  lastAt: number | null;
}
