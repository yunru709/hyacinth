// 进程级共享 HeartbeatScheduler（2026-10-28）
//
// 背景（与当年 MCPSystem 同款坑）：装配是**按会话**跑的（每开一个标签/会话就一整套
// agent-assembly）⇒ 原实现每个装配都 `new HeartbeatScheduler` 各起一条心跳、各自读同一份
// ~/.agent/scheduler/tasks.json ⇒ 同一任务可能被 **N 个心跳各触发一次**（N = 打开的会话数）。
// MCPSystem 早已改成「同 cwd 全进程共用一份」（acquireSharedMcpSystem），scheduler 没跟着改。
//
// 现在改为**全进程共用一份**：
//   - 只有一条心跳、一个 handler ⇒ 不会 N 倍触发；
//   - schedule 工具（add/list/toggle/remove）仍各自 registerToToolRegistry 进各自 registry，
//     但它们引用的是同一份 scheduler（同一份 tasks.json），语义正确、还更一致。
//   - 配置订阅（schedule.heartbeatMs/…）只在首次创建时挂一次，避免重复订阅。

import { HeartbeatScheduler } from './scheduler.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';

let shared: HeartbeatScheduler | null = null;

/**
 * 取得（或首次创建）进程级共享的 HeartbeatScheduler。
 * `created=true` 表示这次真正新建了实例（调用方可据此做一次性接线，如 config 订阅）。
 */
export function acquireSharedScheduler(
  configCenter: RuntimeConfigCenter,
  scheduleConfig?: Record<string, unknown>,
): { scheduler: HeartbeatScheduler; created: boolean } {
  if (shared) return { scheduler: shared, created: false };
  const scheduler = new HeartbeatScheduler(undefined, scheduleConfig as never);
  // config 订阅只挂一次（热更 heartbeatMs/maxConcurrent/timeout/maxRecords）
  scheduler.subscribeConfig(configCenter);
  shared = scheduler;
  return { scheduler, created: true };
}

/** 仅供测试/诊断：清空单例（不 stop 已起的心跳，stop 由 scheduler.stop() 负责） */
export function __resetSharedScheduler(): void {
  shared = null;
}
