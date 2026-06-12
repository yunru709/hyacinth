import type { Tool } from '../tools/interface.js';
import type { SkillDefinition, MCPConfig } from '../types.js';
import type { ContextSource } from '../context/interface.js';
import type { ChannelHandler, ChannelConfig } from '../channels/interface.js';

// ============================================================
// Plugin Manifest
// ============================================================

/**
 * Plugin manifest format（plugin.json）
 *
 * 存放于 .agent/plugins/<plugin-id>/plugin.json 或
 * plugins/<plugin-id>/plugin.json
 */
export interface PluginManifest {
  /** 唯一插件 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 简短描述 */
  description: string;
  /** 入口模块路径（相对于 manifest 目录） */
  entry: string;
  /** 默认是否启用 */
  enabledByDefault?: boolean;
  /** Skill 定义目录列表（相对于 manifest 目录） */
  skills?: string[];
  /** 配置的 JSON Schema */
  configSchema?: Record<string, unknown>;
  /** 插件版本 */
  version?: string;
}

// ============================================================
// Plugin Definition（由 definePlugin() 返回）
// ============================================================

export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  configSchema?: Record<string, unknown>;
  register: (api: PluginApi) => void | Promise<void>;
  onActivate?: (api: PluginApi) => void | Promise<void>;
  onDeactivate?: (api: PluginApi) => void | Promise<void>;
}

// ============================================================
// Plugin API（暴露给插件的能力）
// ============================================================

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface PluginApi {
  /** 注册一个工具到 ToolRegistry */
  registerTool(tool: Tool): void;
  /** 注册一个 Skill */
  registerSkill(skill: SkillDefinition): void;
  /** 注册一个 ContextSource */
  registerContextSource(source: ContextSource): void;
  /** 注册一个 MCP Server 配置（PluginManager 负责连接和桥接） */
  registerMcpServer(config: MCPConfig): void;
  /** 注册一个渠道处理器（将插件扩展为 IM / Webhook / 自定义消息源） */
  registerChannel(handler: ChannelHandler, config?: ChannelConfig): void;

  /** 取消注册一个工具 */
  unregisterTool(name: string): void;
  /** 取消注册一个 Skill */
  unregisterSkill(name: string): void;
  /** 取消注册一个 MCP Server */
  unregisterMcpServer(name: string): void;
  /** 取消注册一个 ContextSource */
  unregisterContextSource(name: string): void;

  /** 获取插件自身的配置 */
  getConfig<T = Record<string, unknown>>(): T;
  /** 日志记录器 */
  logger: PluginLogger;
  /** 插件 ID */
  pluginId: string;
}

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