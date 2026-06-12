export { HotReloadManager } from './manager.js';
export type { HotReloadDeps } from './manager.js';

// ── Watcher functions (conditionally loaded by HotReloadManager) ──

export { watchMcpConfig } from './mcp-watcher.js';
export { watchPluginsDir } from './plugin-watcher.js';
export { watchPrompts } from './prompt-watcher.js';
export { watchAgentsJson } from './agent-watcher.js';
export { watchConfigJson } from './config-watcher.js';
export { watchTools } from './tool-watcher.js';
export { watchSkills } from './skill-watcher.js';
export { watchCommandsJson } from './command-watcher.js';