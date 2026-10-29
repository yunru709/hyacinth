/**
 * 条件任务端口（2026-10-29 自动化改造）
 *
 * 问题：自动化任务的两种触发方式分居两个业务核心——
 *   时间类 → schedule/scheduler（HeartbeatScheduler）
 *   条件类 → watch/watch-service（WatchService）
 * 若 scheduler 直接 import watch，就与 `watch → schedule/session-port` 形成**循环依赖**，
 * 而且两个业务核心互相耦合后谁也不好单独测。
 *
 * 解法（与 SchedulerSessionPort 同一套路）：schedule 层只声明**窄接口**，
 * 由 watch 层实现并在启动时注册进来。scheduler 只认这个接口，不知道 watch 的存在。
 *
 * 生命周期约定（关键，写错就会"重启后条件任务全部失效"或"重复登记"）：
 *   - start() 之后：对所有 enabled 的条件任务调 arm()
 *   - addTask / updateTask（改回时间类要 disarm）/ deleteTask / enable / disable：同步同步
 *   - 同一 taskId 重复 arm 必须幂等（实现方负责先 disarm）
 */

import type { ScheduledTaskTrigger } from './types.js';

/** arm 需要的任务信息（只取条件触发用得上的字段） */
export interface ConditionTaskSpec {
  id: string;
  name: string;
  trigger: Extract<ScheduledTaskTrigger, { type: 'condition' }>;
  /** 事件命中后唤醒哪个会话（缺省则只记录事件，不唤醒） */
  channel?: string;
  sessionId?: string;
  enabled: boolean;
}

export interface ConditionTaskRunner {
  /** 登记（或重新登记）某任务的条件监控。实现方必须保证幂等。 */
  arm(task: ConditionTaskSpec): void;
  /** 注销某任务的监控；不存在时静默成功 */
  disarm(taskId: string): void;
  /** 注销全部（停机用） */
  disarmAll(): void;
  /** 当前登记中的任务 id（诊断/测试用） */
  listArmed(): string[];
}

let runner: ConditionTaskRunner | undefined;

export function setConditionTaskRunner(r: ConditionTaskRunner | undefined): void {
  runner = r;
}

/**
 * 取条件任务执行器。
 * 未注册时返回 undefined —— scheduler 据此**跳过条件任务**（只保留持久化记录），
 * 而不是抛错。这样"没接 watch 的极简部署"仍能正常跑时间类任务。
 */
export function getConditionTaskRunner(): ConditionTaskRunner | undefined {
  return runner;
}
