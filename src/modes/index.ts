/**
 * Mode System — Bootstrap 模式（首轮身份初始化）
 *
 * Plan / Spec / TODO 已迁移至 Workflow 系统（src/workflow/）。
 * 此处仅保留 bootstrap 模式用于首次运行时的身份设置。
 */

export { ModeManager } from './manager.js';
export { createBootstrapMode } from './bootstrap.mode.js';
export { extractTextContent } from './utils.js';
export type { ModeState, ModeDefinition } from './types.js';
