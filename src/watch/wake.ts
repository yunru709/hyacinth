/**
 * 监控事件的唤醒与提示词（2026-10-29）
 *
 * 为什么单独一层：唤醒逻辑有两个消费者 ——
 *   1. 工具层（watch_start 手动登记的监控）
 *   2. ConditionTaskRunner（自动化任务里的条件触发）
 * 放在任一方都会让另一方反向依赖。抽成独立模块后，两者都只依赖它。
 */

import { getSchedulerSessionPort } from '../schedule/session-port.js';
import type { WatchEvent } from './watch-service.js';

/** 事件转成唤醒提示词。要点：说清"是什么触发了"，并明确不需要重新登记监控。 */
export function buildWatchPrompt(event: WatchEvent): string {
  return [
    '[Watch Event]',
    `监控项「${event.note ?? event.summary}」发生了变化。`,
    `- watchId: ${event.watchId}`,
    `- 类型: ${event.kind}`,
    `- 变化程度: ${event.distance}`,
    `- 时间: ${new Date(event.at).toISOString()}`,
    '',
    '这是你之前登记的后台监控触发了。请判断是否需要行动：',
    '需要就直接处理；不需要就说明一句。监控会在冷却期后自动继续，不要重复登记；',
    '如果已经不需要它，用 watch_stop 停掉（或到自动化任务里停用）。',
  ].join('\n');
}

/** 唤醒 owner 会话。失败只记录日志——监控本身不该因为唤醒失败而中断。 */
export async function wakeOwner(event: WatchEvent): Promise<void> {
  const owner = event.owner;
  if (!owner) return;
  const port = getSchedulerSessionPort();
  if (!port?.runPrompt) return; // 端口未接线（如测试环境）：仅记录事件
  try {
    await port.runPrompt(owner.channel, owner.sessionId, buildWatchPrompt(event));
  } catch (err) {
    console.error('[watch] wake session failed:', (err as Error).message);
  }
}
