import chalk from 'chalk';
import type { Tool } from '../tools/interface.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillDefinition, MCPConfig } from '../types.js';
import type { ContextSource } from '../context/interface.js';
import type { ContextComposer } from '../context/interface.js';
import type { ChannelHandler, ChannelConfig } from '../channels/interface.js';
import type {
  PluginApi,
  PluginLogger,
  HostTool,
  HostContextSource,
  HostSkillDefinition,
  HostMcpConfig,
  HostChannelHandler,
  HostChannelConfig,
} from '../plugin-sdk/types.js';
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
  /** 主循环钩子桥（PluginHost 注入；未注入时 api.onHook/aroundHook 为 undefined） */
  hooks?: {
    onHook(name: string, handler: (payload: unknown) => void | Promise<void>): unknown;
    aroundHook(name: string, handler: (payload: unknown, next: (p: unknown) => Promise<unknown>) => Promise<unknown>): unknown;
  };
  /** 内核服务注册桥（PluginHost 注入；未注入时 api.registerService 抛错） */
  onServiceRegister?: (key: string, service: unknown) => void;
  /** 内核服务读取桥（PluginHost 注入；未注入时 api.getService 抛错） */
  onServiceGet?: (key: string) => unknown | undefined;
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
    hooks,
    onServiceRegister,
    onServiceGet,
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

    registerService(key: string, service: unknown): void {
      if (!onServiceRegister) {
        throw new Error(`[${pluginId}] registerService requires host-backed activation (kernel PluginContext)`);
      }
      onServiceRegister(key, service);
      logger.debug(`registered service: ${key}`);
    },

    getService<T = unknown>(key: string): T | undefined {
      if (!onServiceGet) {
        throw new Error(`[${pluginId}] getService requires host-backed activation (kernel PluginContext)`);
      }
      return onServiceGet(key) as T | undefined;
    },

    registerTool(tool: HostTool): void {
      toolRegistry.register(tool as Tool);
      onToolRegister?.(tool.name);
      logger.debug(`registered tool: ${tool.name}`);
    },

    registerSkill(skill: HostSkillDefinition): void {
      skillRegistry.register(skill as SkillDefinition);
      onSkillRegister?.(skill.name);
      logger.debug(`registered skill: ${skill.name}`);
    },

    registerContextSource(source: HostContextSource): void {
      if (contextComposer.registerSource) {
        contextComposer.registerSource(source as ContextSource);
        onContextSourceRegister?.(source.name);
        logger.debug(`registered context source: ${source.name}`);
      } else {
        logger.warn(`ContextComposer does not support registerSource; cannot register "${source.name}"`);
      }
    },

    registerMcpServer(config: HostMcpConfig): void {
      onMcpServerRegister(pluginId, config as MCPConfig);
      logger.debug(`registered MCP server config: ${config.name}`);
    },

    registerChannel(handler: HostChannelHandler, config?: HostChannelConfig): void {
      onChannelRegister(handler as ChannelHandler, config as ChannelConfig | undefined);
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

    unregisterChannel(id: string): void {
      // ChannelManager.unregister 由 onChannelUnregister 回调处理（如果注入了的话）
      // 此处仅做日志记录；实际注销通过 PluginHost 自动回滚完成
      logger.debug(`unregistered channel: ${id}`);
    },
    onHook: hooks
      ? (name, handler) => { hooks.onHook(name, handler); }
      : undefined,
    aroundHook: hooks
      ? (name, handler) => { hooks.aroundHook(name, handler); }
      : undefined,

    getConfig<T = Record<string, unknown>>(): T {
      return pluginConfig as T;
    },
  };

  return api;
}

// ============================================================
// 同源守卫 —— 内部类型必须始终满足 sdk 窄接口（结构漂移 → 编译失败）
// ============================================================
type _SdkGuard =
  & (Tool extends HostTool ? unknown : never)
  & (ContextSource extends HostContextSource ? unknown : never)
  & (SkillDefinition extends HostSkillDefinition ? unknown : never)
  & (MCPConfig extends HostMcpConfig ? unknown : never)
  & (ChannelHandler extends HostChannelHandler ? unknown : never);

/** 编译期断言出口：任一守卫失败则 _SdkGuard = never，本赋值报错 */
export const _sdkTypeGuard: _SdkGuard = {};