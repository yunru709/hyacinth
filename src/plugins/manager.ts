import path from 'node:path';
import type { ToolRegistry } from '../tools/registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { ContextSource } from '../context/interface.js';
import type { MCPConfig } from '../types.js';
import type { MCPSystem } from '../mcp/system.js';
import type { PluginManifest, PluginDefinition, PluginInstance, PluginStatus, PluginApi } from './types.js';
import type { ChannelHandler, ChannelConfig } from '../channels/interface.js';
import type { ChannelManager } from '../channels/manager.js';
import { PluginLoader } from './loader.js';
import { createPluginApi } from './api.js';
import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';

export type PluginManagerDeps = {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  contextComposer: LayeredContextComposer;
  projectDir: string;
  /** 渠道管理器（可选 — 支持插件注册渠道） */
  channelManager?: ChannelManager;
  /** MCP 系统 — 插件 MCP Server 统一委托 MCPSystem 管理生命周期 */
  mcpSystem?: MCPSystem;
};

/**
 * PluginManager — 插件生命周期管理器
 *
 * 职责：
 *  - 发现插件（扫描目录加载 manifest）
 *  - 加载插件（dynamic import 入口模块）
 *  - 激活插件（调用 register()，提供 PluginApi）
 *  - 连接插件的 MCP Server
 *  - 注册插件的 Skill ContextSource
 *  - 停用/清理
 */
export class PluginManager {
  private plugins = new Map<string, PluginInstance>();
  private loader: PluginLoader;
  private deps: PluginManagerDeps;
  private logger: Logger;

  /** MCP Server 注册队列（等待所有插件 register 完成后统一连接） */
  private pendingMcpConfigs: Array<{ pluginId: string; config: MCPConfig }> = [];

  /** 追踪每个插件注册的项目（用于 deactivate 时清理） */
  private pluginRegistrations = new Map<string, {
    tools: string[];
    skills: string[];
    mcpServers: string[];
    contextSources: string[];
  }>();

  constructor(deps: PluginManagerDeps) {
    this.deps = deps;
    this.loader = new PluginLoader(deps.projectDir);
    this.logger = createLogger('plugins');
  }

  // =============================================================
  // Public API
  // =============================================================

  /** 获取所有插件实例 */
  getAll(): PluginInstance[] {
    return [...this.plugins.values()];
  }

  /** 获取指定插件 */
  get(id: string): PluginInstance | undefined {
    return this.plugins.get(id);
  }

  /** 获取已激活的插件 */
  getActivated(): PluginInstance[] {
    return this.getAll().filter((p) => p.status === 'activated');
  }

  /** 完整流程：发现 → 加载 → 激活 → 连接 MCP → 注册 Skill 源 */
  async loadAll(): Promise<void> {
    const manifests = await this.loader.discover();

    if (manifests.length === 0) {
      this.logger.info('no plugins found');
      return;
    }

    this.logger.info('plugins discovered', { count: manifests.length, ids: manifests.map((m) => m.id) });

    const pluginConfigs = await this.loader.loadPluginConfig();

    for (const manifest of manifests) {
      await this.loadPlugin(manifest);
    }

    for (const instance of this.plugins.values()) {
      if (instance.status === 'loaded') {
        const config = pluginConfigs[instance.manifest.id] ?? {};
        await this.activatePlugin(instance, config);
      }
    }

    // 连接插件注册的 MCP Server
    await this.connectPluginMcpServers();

    // 注册 Skill ContextSource
    this.registerPluginSkillSources();
  }

  /** 激活指定插件 */
  async activate(id: string, config?: Record<string, unknown>): Promise<void> {
    const instance = this.plugins.get(id);
    if (!instance) throw new Error(`Plugin "${id}" not found`);
    if (instance.status === 'activated') return;

    const pluginConfigs = config ?? (await this.loader.loadPluginConfig())[id] ?? {};
    await this.activatePlugin(instance, pluginConfigs);
  }

  /** 停用指定插件 */
  async deactivate(id: string): Promise<void> {
    const instance = this.plugins.get(id);
    if (!instance) throw new Error(`Plugin "${id}" not found`);
    if (instance.status !== 'activated') return;

    try {
      await instance.definition.onDeactivate?.(
        this.createApiForPlugin(instance, {}),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`error deactivating`, new Error(msg), { plugin: id });
    }

    // 清理插件注册的所有项目
    const reg = this.pluginRegistrations.get(id);
    if (reg) {
      // 取消注册 tools
      for (const name of reg.tools) {
        this.deps.toolRegistry.unregister(name);
      }
      // 取消注册 skills
      for (const name of reg.skills) {
        this.deps.skillRegistry.unregister(name);
      }
      // 取消注册 context sources
      for (const name of reg.contextSources) {
        if ((this.deps.contextComposer as any).unregisterSource) {
          (this.deps.contextComposer as any).unregisterSource(name);
        }
      }
      // 清理插件注册的 MCP Server（通过 MCPSystem 统一管理）
      if (this.deps.mcpSystem && reg.mcpServers.length > 0) {
        for (const serverName of reg.mcpServers) {
          this.deps.mcpSystem.removeExternalServer(serverName).catch((err) => {
            this.logger.warn(`failed to remove plugin MCP server "${serverName}"`, { error: (err as Error).message });
          });
        }
      }
      this.pluginRegistrations.delete(id);
    }

    instance.status = 'deactivated';
    this.logger.info('deactivated', { plugin: id });
  }

  // =============================================================
  // Internal
  // =============================================================

  /** 加载一个插件的 manifest + entry module */
  private async loadPlugin(manifest: PluginManifest): Promise<void> {
    if (this.plugins.has(manifest.id)) {
      this.logger.warn('duplicate plugin id, skipping', { plugin: manifest.id });
      return;
    }

    const dir = await this.loader.getPluginDir(manifest);
    if (!dir) {
      this.logger.warn('plugin directory not found, skipping', { plugin: manifest.id });
      return;
    }

    const definition = await this.loader.loadEntryModule<PluginDefinition>(manifest);
    if (!definition) {
      this.plugins.set(manifest.id, {
        manifest,
        definition: { id: manifest.id, name: manifest.name, description: manifest.description, register: () => {} },
        status: 'error',
        mcpServers: [],
        dir,
        error: 'Failed to load entry module',
      });
      return;
    }

    // 验证 definition id 与 manifest 一致
    if (definition.id && definition.id !== manifest.id) {
      this.logger.warn('definition id mismatch', { manifest: manifest.id, definition: definition.id });
    }

    const instance: PluginInstance = {
      manifest,
      definition,
      status: 'loaded',
      mcpServers: [],
      dir,
    };

    this.plugins.set(manifest.id, instance);
  }

  /** 激活插件：创建 PluginApi → 调用 register() → 标记 activated */
  private async activatePlugin(
    instance: PluginInstance,
    config: Record<string, unknown>,
  ): Promise<void> {
    const { id } = instance.manifest;

    try {
      const api = this.createApiForPlugin(instance, config);

      await instance.definition.register(api);
      await instance.definition.onActivate?.(api);

      instance.status = 'activated';
      this.logger.info('activated', { plugin: id });
    } catch (error) {
      instance.status = 'error';
      instance.error = error instanceof Error ? error.message : String(error);
      this.logger.error(`failed to activate`, error instanceof Error ? error : new Error(String(error)), { plugin: id });
    }
  }

  /** 为插件创建 PluginApi */
  private createApiForPlugin(
    instance: PluginInstance,
    config: Record<string, unknown>,
  ): PluginApi {
    const pluginId = instance.manifest.id;

    // 初始化追踪记录
    const reg = { tools: [] as string[], skills: [] as string[], mcpServers: [] as string[], contextSources: [] as string[] };
    this.pluginRegistrations.set(pluginId, reg);

    return createPluginApi({
      pluginId,
      toolRegistry: this.deps.toolRegistry,
      skillRegistry: this.deps.skillRegistry,
      contextComposer: this.deps.contextComposer,
      pluginConfig: config,
      pendingMcpConfigs: this.pendingMcpConfigs,
      onMcpServerRegister: (pid, mcpConfig) => {
        this.pendingMcpConfigs.push({ pluginId: pid, config: mcpConfig });
        instance.mcpServers.push(mcpConfig);
        reg.mcpServers.push(mcpConfig.name);
      },
      onToolRegister: (name) => {
        reg.tools.push(name);
      },
      onSkillRegister: (name) => {
        reg.skills.push(name);
      },
      onContextSourceRegister: (name) => {
        reg.contextSources.push(name);
      },
      onMcpServerUnregister: (name) => {
        const idx = reg.mcpServers.indexOf(name);
        if (idx >= 0) reg.mcpServers.splice(idx, 1);
      },
      // 渠道注册回调 → ChannelManager
      onChannelRegister: (handler: ChannelHandler, config?: ChannelConfig) => {
        if (this.deps.channelManager) {
          this.deps.channelManager.register(handler, config);
          this.logger.info('plugin registered channel', { plugin: instance.manifest.id, channel: handler.id });
        } else {
          this.logger.warn('no ChannelManager available, channel not registered', { channel: handler.id });
        }
      },
    });
  }

  /** 将插件注册的 MCP Server 统一委托 MCPSystem 管理 */
  private async connectPluginMcpServers(): Promise<void> {
    if (this.pendingMcpConfigs.length === 0) return;

    // 如果没有注入 MCPSystem，跳过（保持向后兼容，插件 MCP 功能不可用）
    if (!this.deps.mcpSystem) {
      this.logger.warn('no MCPSystem available, skipping plugin MCP servers', { count: this.pendingMcpConfigs.length });
      return;
    }

    this.logger.info('delegating plugin MCP servers to MCPSystem', { count: this.pendingMcpConfigs.length });

    const configs = this.pendingMcpConfigs.map(({ config }) => config);
    // loadAll() 在启动时调用，此时无对话缓存，用 isHotPlug: false → Zone 2
    await this.deps.mcpSystem.addExternalServers(configs, { isHotPlug: false });
  }

  /** 注册插件提供的 Skill 为 ContextSource */
  private registerPluginSkillSources(): void {
    for (const instance of this.getActivated()) {
      const skillDirs = instance.manifest.skills;
      if (!skillDirs || skillDirs.length === 0) continue;

      // 插件 register 时已经通过 api.registerSkill() 注册了 SkillDefinition
      // 这里为每个已注册的 Skill 添加 lazy_expand ContextSource
      const pluginSkills = this.deps.skillRegistry
        .getAll()
        .filter((s) => s.name.startsWith(instance.manifest.id + '-'));

      for (const skill of pluginSkills) {
        this.deps.contextComposer.registerSource({
          name: `plugin-skill-${skill.name}`,
          strategy: 'lazy_expand',
          cacheability: 'manifest',
          description: skill.description,
          getContent: () => this.deps.skillRegistry.getFullDefinitions([skill.name]),
        });
      }
    }
  }
}