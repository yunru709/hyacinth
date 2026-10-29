/**
 * 条件任务执行器（2026-10-29 自动化改造）
 *
 * 把 schedule 层的 `ConditionTaskRunner` 端口实现出来：
 *   自动化任务(condition) ── arm ──► WatchService.start() ── 命中 ──► 唤醒 owner 会话
 *
 * 关键点：
 *   1. **幂等**：同一 taskId 重复 arm 必须先 disarm，否则会挂出多个 watcher，
 *      同一条件反复触发（表现是"唤醒风暴"，很难查）。
 *   2. **映射表**：schedule 只知道 taskId，WatchService 只知道 watchId，
 *      这里维护 taskId → watchId 的对应关系，disarm 时才知道停哪个。
 *   3. 唤醒不在这里做：service-instance 的核心监听统一处理（wake + 外发总线），
 *      这样"手动 watch_*"和"自动化任务"走完全相同的唤醒路径。
 */

import {
  setConditionTaskRunner,
  type ConditionTaskRunner,
  type ConditionTaskSpec,
} from '../schedule/condition-port.js';
import { getWatchService } from './service-instance.js';
import type { WatchSpec } from './types.js';

export function createConditionTaskRunner(): ConditionTaskRunner {
  // 与手动 watch_* 共用同一个 WatchService 实例
  const service = getWatchService();
  /** taskId（schedule 侧） → watchId（watch 侧） */
  const taskToWatch = new Map<string, string>();

  const disarm = (taskId: string): void => {
    const watchId = taskToWatch.get(taskId);
    if (!watchId) return;
    service.stop(watchId);
    taskToWatch.delete(taskId);
  };

  return {
    arm(task: ConditionTaskSpec): void {
      // 幂等：先撤销旧的（可能是改了参数后重新登记）
      disarm(task.id);

      const spec = {
        kind: task.trigger.kind,
        ...task.trigger.spec,
      } as unknown as WatchSpec;

      const info = service.start(spec, {
        note: task.name,
        intervalMs: task.trigger.intervalMs,
        cooldownMs: task.trigger.cooldownMs,
        threshold: task.trigger.threshold,
        settleFrames: task.trigger.settleFrames,
        // 没有 channel/sessionId 就只记事件、不唤醒（与 watch_* 工具的行为一致）
        owner:
          task.channel && task.sessionId
            ? { channel: task.channel, sessionId: task.sessionId }
            : undefined,
      });

      taskToWatch.set(task.id, info.watchId);
    },

    disarm,

    disarmAll(): void {
      for (const taskId of [...taskToWatch.keys()]) disarm(taskId);
    },

    listArmed(): string[] {
      return [...taskToWatch.keys()];
    },
  };
}

let installed = false;

/**
 * 安装条件任务执行器（幂等）。
 * 由 tools 层装配时调用一次 —— 放这里而不是 gateway，
 * 是因为 gateway 属 UI 适配层，不得直连业务核心 watch（verify:layers 规则 5）。
 */
export function installConditionTaskRunner(): void {
  if (installed) return;
  installed = true;
  setConditionTaskRunner(createConditionTaskRunner());
}
