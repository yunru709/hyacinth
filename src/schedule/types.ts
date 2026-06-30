/** 定时任务类型 */
export type ScheduleType = 'interval' | 'cron' | 'daily' | 'fixed-time' | 'random';

/** 间隔调度配置 */
export interface IntervalConfig {
  /** 间隔毫秒数 */
  intervalMs: number;
  /** 首次执行前等待时间（可选），默认立即执行 */
  delayFirst?: boolean;
}

/** Cron 调度配置（5 字段标准 cron） */
export interface CronConfig {
  /** Cron 表达式：分 时 日 月 周 */
  expression: string;
}

/** 每日定点调度配置 */
export interface DailyConfig {
  /** 执行时间，格式 HH:mm（24 小时制） */
  time: string;
  /** 时区，默认 local */
  timezone?: string;
}

/** 固定时间调度配置（一次性任务） */
export interface FixedTimeConfig {
  /** ISO 8601 执行时间 */
  runAt: string;
}

/** 时间窗口 */
export interface TimeWindow {
  /** 窗口起始，格式 HH:mm（24 小时制），如 "09:00" */
  start: string;
  /** 窗口结束，格式 HH:mm（24 小时制），如 "18:00"。若小于 start 则跨越午夜 */
  end: string;
}

/** 次数范围（替代固定 count） */
export interface CountRange {
  /** 最少触发次数 */
  min: number;
  /** 最多触发次数 */
  max: number;
  /** 概率分布：uniform = 均匀，extremes = min 和 max 概率更高（U 形） */
  distribution?: 'uniform' | 'extremes';
}

/** 时间概率权重控制点 */
export interface TimeWeight {
  /** 时间点，格式 HH:mm（24 小时制） */
  time: string;
  /** 相对权重，> 0。1.0 = 基准，2.0 = 两倍概率 */
  weight: number;
}

/** 随机调度配置 */
export interface RandomConfig {
  /** 周期时长（毫秒），例如 3600000 = 1小时，86400000 = 24小时 */
  periodMs: number;
  /**
   * 周期内触发次数（固定值）。
   * 与 countRange 互斥：指定固定 count 则每次周期精确触发 count 次；
   * 指定 countRange 则每周期在 [min, max] 内随机取一个值。
   */
  count: number;
  /** 可变触发次数（与固定 count 互斥，优先使用） */
  countRange?: CountRange;
  /** 最小间隔（毫秒），防止两次触发太近，默认 0 */
  minIntervalMs?: number;
  /** 时间窗口（可选），限制随机触发仅在指定时间段内 */
  timeWindow?: TimeWindow;
  /**
   * 时间概率权重（可选）。
   * 控制点在时间轴上定义相对概率，控制点之间线性插值。
   * 例：{ time: "12:00", weight: 3.0 } 表示正午概率是基准的 3 倍。
   * 未指定则均匀分布。
   */
  timeWeights?: TimeWeight[];
}

/** 调度配置联合 */
export type ScheduleConfig = IntervalConfig | CronConfig | DailyConfig | FixedTimeConfig | RandomConfig;

/** 任务执行动作 */
export interface TaskAction {
  /** 动作类型 */
  type: 'callback' | 'skill' | 'command' | 'scheduled';
  /** 动作标识（callback 名 / skill 名 / shell 命令） */
  target: string;
  /** 动作参数 */
  payload?: Record<string, unknown>;
}

/** 定时任务定义 */
export interface ScheduledTask {
  /** 唯一标识 */
  id: string;
  /** 任务名称 */
  name: string;
  /** 调度类型 */
  scheduleType: ScheduleType;
  /** 调度配置 */
  schedule: ScheduleConfig;
  /** 执行动作 */
  action: TaskAction;
  /** 是否启用 */
  enabled: boolean;
  /**
   * 任务所属模式（可选）。
   * - undefined: 无模式限制，正常/陪伴模式下均触发（向后兼容）
   * - 'normal': 仅在正常模式下触发
   * - 'companion': 仅在陪伴模式下触发
   * add_task 工具会自动根据当前模式设置此字段。
   */
  mode?: 'normal' | 'companion';
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 上次执行时间 */
  lastRunAt: string | null;
  /** 下次执行时间 */
  nextRunAt: string | null;
  /** 累计执行次数 */
  runCount: number;
  /** 出错次数 */
  errorCount: number;
  /** 标签（用于分组/过滤） */
  tags: string[];
  /** 当前周期起始时间（random 类型使用，ISO 8601） */
  periodStartAt?: string;
  /** 本周期内已生成但尚未触发的时刻列表（random 类型使用） */
  pendingSlots?: string[];
  /**
   * 目标渠道名（可选）。
   * - 为空且 action.type === 'command' → 直接执行，不涉及渠道
   * - 为空且 action.type 需要 AI 交互 → 触发到创建时所在渠道，或 fallback 到主 loop
   * - 指定值 → 仅触发到该渠道（如 'tui', 'webui', 'feishu'）
   */
  channel?: string;
  /**
   * 创建此任务时的 session ID（可选）。
   * 多会话渠道（飞书等）依赖此字段确定将定时任务结果发回哪个聊天。
   * 由 add_task 工具自动从当前 session 检测并填入。
   */
  sessionId?: string;
  /**
   * 渠道降级链（可选）。
   * 当 `channel` 指定的渠道离线时，按此数组顺序尝试降级。
   * 例：["webui", "tui"] → 先试 webui，再试 tui。
   * 为空时使用全局默认降级链（SchedulerConfig.channelFallback）。
   */
  fallback?: string[];
}

/** 任务执行记录 */
export interface TaskExecutionRecord {
  taskId: string;
  taskName: string;
  executedAt: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** 调度器配置 */
export interface SchedulerConfig {
  /** 心跳检查间隔（毫秒），默认 5000 */
  heartbeatMs: number;
  /** 最大并发任务数，默认 10 */
  maxConcurrent: number;
  /** 任务超时（毫秒），默认 300000（5 分钟） */
  taskTimeoutMs: number;
  /** 执行记录保留条数，默认 1000 */
  maxRecords: number;
  /**
   * 全局默认渠道降级链。
   * 当任务的 channel 离线且未配置 fallback 时，按此顺序尝试。
   * 默认：["tui"] — 只有在 TUI 存活时才降级，否则丢弃。
   */
  channelFallback?: string[];
}

/** 调度器状态 */
export interface SchedulerStatus {
  running: boolean;
  startedAt: string | null;
  taskCount: number;
  enabledTaskCount: number;
  recentExecutions: TaskExecutionRecord[];
  uptime: number | null;
}

/** 持久化数据格式 */
export interface SerializedSchedulerData {
  version: number;
  tasks: ScheduledTask[];
  records: TaskExecutionRecord[];
}