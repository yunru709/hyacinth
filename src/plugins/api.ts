import chalk from 'chalk';
import type { Tool } from '../tools/interface.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillDefinition, MCPConfig } from '../types.js';
import type { ContextSource } from '../context/interface.js';
import type { ContextComposer } from '../context/interface.js';
import type { ChannelHandler, ChannelConfig } from '../channels/interface.js';
import type { PluginApi, PluginLogger } from './types.js';
import { createLogger } from '../logging/logger.js';

/** PluginApi 构造参数 */
export interface PluginApiOptions {
  pluginId: string;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  contextComposer: ContextComposer & { registerSource?: (source: ContextSource) => void; unregisterSource?: (name: string) => void };
  pluginConfig: Record<string, unknown>;
  onMcpServerRegister: (pluginId: string, config: MCPConfig) => void;
  /** 渠道注册回调 → ChannelManager.register() */
  onChannelRegister: (handler: ChannelHandler, config?: ChannelConfig) => void;
  /** MCP Server 注册队列，用于 unregister */
  pendingMcpConfigs?: Array<{ pluginId: string; config: MCPConfig }>;
  /** 注册追踪回调（供 PluginManager 追踪插件注册项） */
  onToolRegister?: (name: string) => void;
  onSkillRegister?: (name: string) => void;
  onContextSourceRegister?: (name: string) => void;
  onMcpServerUnregister?: (name: string) => void;
}

/**
 * 创建 PluginApi 实例
 *
 * 每个插件在 register() 时获得一个独立的 PluginApi，
 * 其操作会直接作用于宿主系统的各注册表。
 */
export function createPluginApi(options: PluginApiOptions): PluginApi {
  const {
    pluginId, toolRegistry, skillRegistry,
    contextComposer, pluginConfig,
    onMcpServerRegister, onChannelRegister,
    pendingMcpConfigs,
    onToolRegister, onSkillRegister, onContextSourceRegister,
    onMcpServerUnregister,
  } = options;

  const pluginLogger = createLogger(`plugin:${pluginId}`);

  const logger: PluginLogger = {
    info: (msg, ...args) => pluginLogger.info(msg, { args }),
    warn: (msg, ...args) => pluginLogger.warn(msg, { args }),
    error: (msg, ...args) => pluginLogger.error(msg, undefined, { args }),
    debug: (msg, ...args) => {
      if (process.env.DEBUG_PLUGIN) {
        pluginLogger.debug(msg, { args });
      }
    },
  };

  const api: PluginApi = {
    pluginId,
    logger,

    registerTool(tool: Tool): void {
      toolRegistry.register(tool);
      onToolRegister?.(tool.name);
      logger.debug(`registered tool: ${tool.name}`);
    },

    registerSkill(skill: SkillDefinition): void {
      skillRegistry.register(skill);
      onSkillRegister?.(skill.name);
      logger.debug(`registered skill: ${skill.name}`);
    },

    registerContextSource(source: ContextSource): void {
      if (contextComposer.registerSource) {
        contextComposer.registerSource(source);
        onContextSourceRegister?.(source.name);
        logger.debug(`registered context source: ${source.name}`);
      } else {
        logger.warn(`ContextComposer does not support registerSource; cannot register "${source.name}"`);
      }
    },

    registerMcpServer(config: MCPConfig): void {
      onMcpServerRegister(pluginId, config);
      logger.debug(`registered MCP server config: ${config.name}`);
    },

    registerChannel(handler: ChannelHandler, config?: ChannelConfig): void {
      onChannelRegister(handler, config);
      logger.debug(`registered channel: ${handler.id} (${handler.name})`);
    },

    unregisterTool(name: string): void {
      toolRegistry.unregister(name);
      logger.debug(`unregistered tool: ${name}`);
    },

    unregisterSkill(name: string): void {
      skillRegistry.unregister(name);
      logger.debug(`unregistered skill: ${name}`);
    },

    unregisterMcpServer(name: string): void {
      onMcpServerUnregister?.(name);
      // Remove from pendingMcpConfigs if provided
      if (pendingMcpConfigs) {
        const idx = pendingMcpConfigs.findIndex((c) => c.pluginId === pluginId && c.config.name === name);
        if (idx >= 0) pendingMcpConfigs.splice(idx, 1);
      }
      logger.debug(`unregistered MCP server: ${name}`);
    },

    unregisterContextSource(name: string): void {
      if (contextComposer.unregisterSource) {
        contextComposer.unregisterSource(name);
        logger.debug(`unregistered context source: ${name}`);
      } else {
        logger.warn(`ContextComposer does not support unregisterSource; cannot unregister "${name}"`);
      }
    },

    getConfig<T = Record<string, unknown>>(): T {
      return pluginConfig as T;
    },
  };

  return api;
}