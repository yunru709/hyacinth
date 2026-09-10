/**
 * 完整性自检（integrity canary）—— 参照 dsh 的 probe/诚实上报哲学。
 *
 * 状态三档：off（未安装）/ on（守卫在位）/ degraded（守卫被拆）。
 * canary 在 bootstrap 结束、每次插件 mount 后与关键裁决前运行：
 * 检查守卫标记是否仍在位；被拆则降级 + 审计 + fail-closed（危险裁决在
 * degraded 下一律拒绝，不再依赖"守卫可能失效的判断"）。
 */

import { createLogger } from '../../logging/logger.js';
import { appendAudit } from './audit.js';
import type { KernelStatus } from './types.js';

const logger = createLogger('security-kernel').child('mod', { sub: 'integrity' });

let status: KernelStatus = 'off';
let degradedReason: string | null = null;

export function getSecurityStatus(): KernelStatus {
  return status;
}

export function getDegradedReason(): string | null {
  return degradedReason;
}

/** bootstrap 成功安装后调用（只允许从 off → on 一次） */
export function markInstalled(): void {
  if (status === 'off') {
    status = 'on';
    appendAudit({ type: 'kernel.installed' });
  }
}

/** 关闭内核（security.mode=off 时由 bootstrap 调用） */
export function markOff(): void {
  status = 'off';
}

/** 守卫被拆：降级 + 审计（幂等，只记第一次原因） */
export function markDegraded(reason: string): void {
  if (status === 'degraded') return;
  status = 'degraded';
  degradedReason = reason;
  logger.error(`security kernel DEGRADED: ${reason}`, undefined, { reason });
  appendAudit({ type: 'kernel.degraded', reason });
}
