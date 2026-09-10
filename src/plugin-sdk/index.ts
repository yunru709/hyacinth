/**
 * plugin-sdk —— 插件开发者唯一公共入口。
 *
 * 插件开发者（TS）从此入口 import 契约类型与 definePlugin；
 * 纯 JS 插件（companion 风格）无需任何 import，宿主注入的 api 已足够。
 */

export { definePlugin } from '../plugins/define.js';
export type { DefinePluginOptions } from '../plugins/define.js';

export {
  SERVICE_CATALOG,
  type ServiceKey,
} from './types.js';

export type {
  // 契约
  PluginManifest,
  PluginDefinition,
  PluginApi,
  PluginLogger,
  // 能力窄接口
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
} from './types.js';
