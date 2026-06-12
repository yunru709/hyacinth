/**
 * 向后兼容层 — 所有实现已迁移至 loop-guard.ts
 *
 * @deprecated 新代码请直接从 ../repair/loop-guard.js 导入 LoopGuard / ToolGuard 等
 */
export { ToolGuard as StormBreaker, isMutating } from './loop-guard.js';
