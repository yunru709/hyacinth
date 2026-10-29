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

import { getGlobalTriggerHub } from '../trigger/hub.js';
import { createDefaultProbeRegistry } from './probes/index.js';
import type { WatchEvent } from './watch-service.js';
import { WatchService } from './watch-service.js';
import { wakeOwner } from './wake.js';

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
    // 核心监听（2026-10-29 自动化改造）：唤醒 owner + 外发触发总线。
    // ⚠️ 必须挂在这里，不能放工具层的懒加载里 ——
    // 自动化任务的条件触发可能**完全没经过 watch_* 工具**，那时工具层从未初始化，
    // 懒加载的监听就不会注册 ⇒ 条件命中后没人唤醒，任务等于静默失效。
    // 放在单例创建处，保证"只要存在监控，就一定有消费者"。
    onWatchEvent((event) => {
      void wakeOwner(event);
      const hub = getGlobalTriggerHub();
      if (hub) {
        void hub.fire({
          source: 'watch',
          name: event.note ?? event.summary,
          detail: {
            watchId: event.watchId,
            kind: event.kind,
            distance: event.distance,
            owner: event.owner,
          },
        });
      }
    });

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
