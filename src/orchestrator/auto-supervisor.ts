/**
 * 自主唤醒调度器（2026-11-04 · 第三步：从「N 个闹钟」收敛成「一个 tick」）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要
 * ────────────────────────────────────────────────────────────────────────────
 * 此前每个 loop 各起一个 `setTimeout` —— 等于 N 个互不知情的闹钟：
 *   · 没法做优先级（谁先醒）
 *   · 没法做并发上限（同时醒 5 个会话，全在跑回合）
 *   · 没法让路（用户正在说话时，所有自主唤醒都该往后排）
 *   · 也没法统一观测（现在到底有几个条件挂着？没人知道）
 *
 * 提成进程级单例后，所有「何时该醒」收敛到**一个** tick，
 * 上面那些策略将来都只需要改这一处。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 边界：这里只管「什么时刻该调谁」，不管「该不该醒」
 * ────────────────────────────────────────────────────────────────────────────
 * 预算闸门（静默时段 / 每小时上限）仍在 loop.onSuspendTimerFire 里过 ——
 * 因为它是**业务策略**（可配置、要记账），而调度器只做**时间**。
 * 混在一起会让调度器变成又一个上帝对象。
 */
import { createLogger } from '../logging/logger.js';

const logger = createLogger('auto-supervisor');

interface PendingWake {
  key: string;
  /** 到期时刻（ms epoch） */
  at: number;
  fire: () => void;
}

/** 单例状态（模块级 = 进程级） */
const pending = new Map<string, PendingWake>();
let timer: ReturnType<typeof setInterval> | null = null;

/** tick 粒度。1s 足够：唤醒不需要毫秒级精度，而更密的 tick 只是空转。 */
const TICK_MS = 1_000;

/** 登记一个唤醒。同 key 重复登记 = 覆盖（不会堆积）。 */
export function scheduleWake(key: string, delayMs: number, fire: () => void): void {
  pending.set(key, { key, at: Date.now() + Math.max(0, delayMs), fire });
  ensureTicking();
}

/** 取消某个唤醒（用户打断 / 关闭自主模式 / 会话销毁时调） */
export function cancelWake(key: string): void {
  if (!pending.delete(key)) return;
  if (pending.size === 0) stopTicking();
}

/** 当前挂着的唤醒数（UI / 诊断用） */
export function pendingWakeCount(): number {
  return pending.size;
}

/** 全部待唤醒的摘要（诊断用；刻意不暴露 fire 回调） */
export function listPendingWakes(): Array<{ key: string; at: number; inMs: number }> {
  const now = Date.now();
  return [...pending.values()].map((p) => ({ key: p.key, at: p.at, inMs: p.at - now }));
}

function ensureTicking(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  // 不要因为这个定时器把进程钉住
  timer.unref?.();
}

function stopTicking(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function tick(): void {
  const now = Date.now();
  // 先快照再遍历：fire() 里可能再次 scheduleWake（自我续挂），
  // 直接遍历 Map 会在迭代中修改结构。
  for (const item of [...pending.values()]) {
    if (item.at > now) continue;
    pending.delete(item.key);
    try {
      item.fire();
    } catch (err) {
      // 单个会话的唤醒失败不该拖垮其它会话的调度
      logger.warn('wake callback failed', { key: item.key, error: (err as Error).message });
    }
  }
  if (pending.size === 0) stopTicking();
}

/** 测试用：清空全部待唤醒并停表（真实进程里不需要调） */
export function resetSupervisor(): void {
  pending.clear();
  stopTicking();
}
