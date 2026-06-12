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

/** 随机调度配置 */
export interface RandomConfig {
  /** 周期时长（毫秒），例如 3600000 = 1小时，86400000 = 24小时 */
  periodMs: number;
  /** 周期内触发次数 */
  count: number;
  /** 最小间隔（毫秒），防止两次触发太近，默认 0 */
  minIntervalMs?: number;
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