import type { MCPConfig } from '../types.js';
import type { PluginManifest, PluginDefinition, PluginApi, PluginLogger } from '../plugin-sdk/types.js';

// ============================================================
// 插件契约（来源 plugin-sdk —— 自包含，插件开发者可依赖）
// 运行时状态类类型保留在本文件（内部）。
// ============================================================

export type {
  PluginManifest,
  PluginDefinition,
  PluginApi,
  PluginLogger,
} from '../plugin-sdk/types.js';

// ============================================================
// Plugin Instance（运行时状态）
// ============================================================

export type PluginStatus = 'discovered' | 'loaded' | 'activated' | 'deactivated' | 'error';

export interface PluginInstance {
  manifest: PluginManifest;
  definition: PluginDefinition;
  status: PluginStatus;
  /** 注册的 MCP Server 列表（待连接） */
  mcpServers: MCPConfig[];
  /** 插件目录绝对路径 */
  dir: string;
  /** 错误信息（status 为 error 时） */
  error?: string;
}
