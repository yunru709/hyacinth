export { definePlugin } from './define.js';
export type { DefinePluginOptions } from './define.js';
export { createPluginApi } from './api.js';
export type { PluginApiOptions } from './api.js';
export { PluginLoader, type PluginConfigEntry } from './loader.js';
export { wrapAsHyPlugin, type PluginAdapterDeps } from './plugin-adapter.js';
export { PluginManager } from './manager.js';
export type { PluginManagerDeps } from './manager.js';
export type {
  PluginManifest,
  PluginDefinition,
  PluginApi,
  PluginLogger,
  PluginInstance,
  PluginStatus,
} from './types.js';
// ── plugin-sdk 契约面（插件开发者公共入口）──
export { SERVICE_CATALOG, type ServiceKey } from '../plugin-sdk/types.js';
export type {
  HostTool,
  HostContextSource,
  HostContextSourceStrategy,
  HostContextSourceCacheability,
  HostSkillDefinition,
  HostMcpConfig,
  HostChannelHandler,
  HostChannelConfig,
  HostChannelEvent,
  HostChannelMessageEvent,
  HostChannelConnectedEvent,
  HostChannelDisconnectedEvent,
  HostChannelErrorEvent,
  HostChannelReply,
  HostChannelTarget,
  HostChannelStatus,
  HostReplyFn,
  HostAgentFactory,
  HostChannelOutputHandler,
  HostChannelSessionRunner,
} from '../plugin-sdk/types.js';