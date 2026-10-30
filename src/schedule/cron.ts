/**
 * 兼容 re-export（2026-10-30）：CronExpression 已移到 src/utils/cron.ts（纯工具，供 schedule + automation 共用）。
 * 保留本文件以免改动 schedule 内部既有引用（scheduler.ts / index.ts / schedule.test.ts）。
 */
export { CronExpression } from '../utils/cron.js';
