/**
 * WatchService 进程级单例（2026-10-29 自动化改造）
 *
 * 为什么需要它：现在有两类消费者要共享同一批监控——
 *   1. watch_start/watch_stop 工具（用户/模型手动登记）
 *   2. ConditionTaskRunner（自动化任务里的条件触发，由 scheduler 驱动）
 * 如果各自 new 一个 WatchService，watchId 会重复、watch_list 只能看到一半，
 * 排查问题时极其迷惑。所以收敛成一个实例 + 多监听者广播。
 *
 * 广播语义：监听者抛异常只影响自己，不影响其它监听者，更不影响采样循环。
 */

import { createDefaultProbeRegistry } from './probes/index.js';
import type { WatchEvent } from './watch-service.js';
import { WatchService } from './watch-service.js';

export type WatchEventListener = (event: WatchEvent) => void;

const listeners: WatchEventListener[] = [];
let service: WatchService | null = null;

/** 订阅监控事件，返回退订函数 */
export function onWatchEvent(listener: WatchEventListener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** 取（或惰性创建）全局 WatchService */
export function getWatchService(): WatchService {
  if (!service) {
    service = new WatchService({
      registry: createDefaultProbeRegistry(),
      onEvent: (event) => {
        for (const fn of [...listeners]) {
          try {
            fn(event);
          } catch {
            /* 单个监听者出问题不该拖垮采样循环 */
          }
        }
      },
    });
  }
  return service;
}
