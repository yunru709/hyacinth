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
import { PluginLoader, type PluginConfigEntry } from './loader.js';
import { createPluginApi } from './api.js';
import { PluginHost, type HyPlugin, type PluginContext } from '../kernel/plugin-host.js';
import { wrapAsHyPlugin } from './plugin-adapter.js';
import { DisposableStore } from '../kernel/types.js';
import type { LoopHookBus, LoopHooks } from '../orchestrator/loop-hooks.js';
import type { PluginArchitectureDecl } from '../supervisor/extension-registry.js';
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
  /**
   * 架构监督（扩展注册表方案）：装载前的名单裁决面 + 架构贡献申报面（可选，
   * 未装配走原三源语义）。
   * 裁决优先级：名单显式声明 > plugins.config.json > manifest.enabledByDefault；
   * 申报面：reportArchitecture() 把插件 manifest 的 architecture 段提交给注册表。
   */
  extensionRegistry?: {
    adjudicatePluginEnabled(pluginId: string, fallback: boolean): boolean;
    submitPluginArchitecture?(decl: PluginArchitectureDecl): void;
  };
};

/**
 * 插件热更新失败错误。
 *
 * `recovered` 区分两种失败形态，供调用方（plugin-watcher）决定处置：
 * - `recovered=true`：新代码加载/激活失败，但已成功回滚到旧版 —— 插件保持旧版运行，仅记日志；
 * - `recovered=false`：新代码激活失败**且回滚也失败** —— 宿主处于不可靠状态，调用方应升级为
 *   重启兜底（退出码 44，重启后从磁盘重新装载）。
 */
export class PluginReloadError extends Error {
  constructor(
    message: string,
    /** 失败后是否已成功回滚到旧版（true=可继续运行，false=需重启兜底） */
    public readonly recovered: boolean,
  ) {
    super(message);
    this.name = 'PluginReloadError';
  }
}

/**
 * PluginManager — 插件生命周期管理器
 *
 * P2 改造：发现/装载职责保留，生命周期委托给 PluginHost。
 *
 * 职责：
 *  - 发现插件（扫描目录加载 manifest）
 *  - 加载插件（dynamic import 入口模块）
 *  - 激活插件（通过 PluginHost.mount 自动追踪注册项）
 *  - 连接插件的 MCP Server
 *  - 注册插件的 Skill ContextSource
 *  - 停用/清理（PluginHost 卸载自动回滚）
 */
export class PluginManager {
  private plugins = new Map<string, PluginInstance>();
  private loader: PluginLoader;
  private deps: PluginManagerDeps;
  private logger: Logger;

  /** 内核插件宿主（P2：生命周期 + 自动回滚；钩子总线经 setHooks 注入） */
  private host: PluginHost<Record<string, unknown>, LoopHooks>;

  /** MCP Server 注册队列（等待所有插件 register 完成后统一连接） */
  private pendingMcpConfigs: Array<{ pluginId: string; config: MCPConfig }> = [];

  constructor(deps: PluginManagerDeps) {
    this.deps = deps;
    this.loader = new PluginLoader(deps.projectDir);
    this.logger = createLogger('plugins');
    // 能力注册面（工具/ContextSource）经宿主注入，插件可注册能力且卸载自动回滚；
    // 钩子总线初始为空（目录插件挂主循环钩子前需调用 setHooks 注入 loop 的钩子总线）。
    this.host = new PluginHost<Record<string, unknown>, LoopHooks>({
      toolRegistry: deps.toolRegistry,
      contextComposer: deps.contextComposer,
    });
  }

  /**
   * 注入主循环钩子总线（目录插件 api.onHook/aroundHook 的挂载面）。
   *
   * P6-1：改为向既有宿主**追加注入**（PluginHost.setHooks），宿主不重建 ——
   * 已挂载插件不丢失、getHost() 引用稳定、deactivate 不再与真实宿主脱节。
   * 时序要求随之消失：唯一硬约束是插件 **activate 期间调用 onHook 时**总线须
   * 已注入（否则按 noBusError 快速失败，显式报错而非静默丢失）。
   */
  setHooks(hooks: LoopHookBus): void {
    this.host.setHooks(hooks);
  }

  /**
   * 申报架构贡献：把**启用**插件的 architecture 段提交给扩展注册表
   * （source: 'plugin'）。纯数据读取（discover + 读 plugin.json），不执行插件
   * 代码 —— 因此可在插件激活（loadAll）之前调用，让分发表能吃到插件声明。
   * enabled 裁决与 loadAll 同源（名单 > plugins.config.json > enabledByDefault），
   * 未启用的插件声明不生效。未装配扩展注册表时无操作。
   */
  async reportArchitecture(): Promise<void> {
    const reg = this.deps.extensionRegistry;
    if (!reg || typeof reg.submitPluginArchitecture !== 'function') return;
    const manifests = await this.loader.discover();
    const pluginConfigs = await this.loader.loadPluginConfig();
    for (const manifest of manifests) {
      if (!manifest.architecture) continue;
      const configEntry: PluginConfigEntry = pluginConfigs[manifest.id] ?? {
        enabled: manifest.enabledByDefault ?? true,
        config: {},
      };
      const enabledResolved = reg.adjudicatePluginEnabled(manifest.id, configEntry.enabled !== false);
      if (!enabledResolved) continue; // 未启用插件：声明不生效（名单裁决是决定性用户声明）
      reg.submitPluginArchitecture({
        pluginId: manifest.id,
        priority: manifest.priority ?? 0,
        points: Object.entries(manifest.architecture).map(([point, a]) => ({
          point,
          impl: a.impl,
          ...(a.module ? { module: a.module } : {}),
        })),
        dir: (await this.loader.getPluginDir(manifest)) ?? undefined,
      });
    }
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

  /** 增量加载：对比已发现插件，只加载新增/变更的，移除已删除的 */
  async loadAll(): Promise<void> {
    const manifests = await this.loader.discover();
    const discoveredIds = new Set(manifests.map((m) => m.id));
    const currentIds = new Set(this.plugins.keys());

    // 移除已删除的插件（在发现列表中不存在的）
    for (const id of currentIds) {
      if (!discoveredIds.has(id)) {
        this.logger.info('plugin removed, deactivating', { plugin: id });
        await this.deactivate(id).catch(() => {});
        this.plugins.delete(id);
      }
    }

    if (manifests.length === 0) {
      this.logger.info('no plugins found');
      return;
    }

    this.logger.info('plugins discovered', { count: manifests.length, ids: manifests.map((m) => m.id) });

    const pluginConfigs = await this.loader.loadPluginConfig();

    // 加载新发现的或需要重载的插件
    for (const manifest of manifests) {
      const configEntry: PluginConfigEntry = pluginConfigs[manifest.id] ?? {
        enabled: manifest.enabledByDefault ?? true,
        config: {},
      };
      // 装载裁决（三层折叠）：名单显式声明 > plugins.config.json > manifest.enabledByDefault；
      // 裁决为禁用时跳过激活（名单是决定性用户声明，architecture oversight）
      const enabledResolved = this.deps.extensionRegistry
        ? this.deps.extensionRegistry.adjudicatePluginEnabled(manifest.id, configEntry.enabled !== false)
        : configEntry.enabled !== false;
      if (!enabledResolved) {
        this.logger.info('plugin disabled (adjudicated), skipping', { plugin: manifest.id });
        continue;
      }

      const existing = this.plugins.get(manifest.id);
      if (!existing) {
        // 新插件：加载 → 激活
        await this.loadPlugin(manifest);
        const instance = this.plugins.get(manifest.id);
        if (instance?.status === 'loaded') {
          await this.activatePlugin(instance, configEntry.config ?? {});
        }
      } else if (existing.status === 'error') {
        // 之前加载失败的：重试
        this.plugins.delete(manifest.id);
        await this.loadPlugin(manifest);
        const instance = this.plugins.get(manifest.id);
        if (instance?.status === 'loaded') {
          await this.activatePlugin(instance, configEntry.config ?? {});
        }
      }
      // 已激活的插件不重复激活（热重载由 reload() 单独处理）
    }

    // 连接插件注册的 MCP Server
    await this.connectPluginMcpServers();
  }

  /** 激活指定插件 */
  async activate(id: string, config?: Record<string, unknown>): Promise<void> {
    const instance = this.plugins.get(id);
    if (!instance) throw new Error(`Plugin "${id}" not found`);
    if (instance.status === 'activated') return;

    let configEntry: PluginConfigEntry;
    if (config) {
      configEntry = { enabled: true, config };
    } else {
      const pluginConfigs = await this.loader.loadPluginConfig();
      const manifest = instance.manifest;
      configEntry = pluginConfigs[id] ?? {
        enabled: manifest.enabledByDefault ?? true,
        config: {},
      };
      const enabledResolved = this.deps.extensionRegistry
        ? this.deps.extensionRegistry.adjudicatePluginEnabled(id, configEntry.enabled !== false)
        : configEntry.enabled !== false;
      if (!enabledResolved) {
        throw new Error(`Plugin "${id}" is disabled (adjudicated by config or extension registry)`);
      }
    }

    await this.activatePlugin(instance, configEntry.config ?? {});

    // 单插件激活也要连接 MCP（connectPluginMcpServers 幂等，只处理 pending 队列）
    await this.connectPluginMcpServers();
  }

  /** 停用指定插件（PluginHost 卸载自动回滚所有注册项） */
  async deactivate(id: string): Promise<void> {
    const instance = this.plugins.get(id);
    if (!instance) throw new Error(`Plugin "${id}" not found`);
    if (instance.status !== 'activated') return;

    // PluginHost.unmount 自动：
    //  1. 调用 deactivate 回调
    //  2. 逆序释放 DisposableStore 中的所有资源（工具/技能/上下文源等）
    await this.host.unmount(id);

    instance.status = 'deactivated';
    this.logger.info('deactivated', { plugin: id });
  }

  /**
   * 从磁盘热更新插件（S3：插件代码热更新闭环）。
   *
   * 与 `PluginHost.reload` 的区别：后者只重放内存里的旧 definition，
   * 本方法用 `?t=` 缓存破坏**重新 import 磁盘上的最新代码**，
   * 走完整「卸载旧版 → 挂载新版」生命周期。
   *
   * 失败语义（供调用方决定是否升级为重启兜底）：
   * - 新入口模块加载失败（坏语法/import 错误）→ 抛 `PluginReloadError(recovered=true)`，
   *   旧版未动，插件继续以旧版运行；
   * - 新版激活失败 → 自动回滚旧版；回滚成功抛 `recovered=true`，回滚也失败抛 `recovered=false`（需重启）。
   */
  async reloadFromDisk(id: string): Promise<void> {
    const instance = this.plugins.get(id);
    if (!instance) throw new Error(`Plugin "${id}" not found`);
    if (instance.status !== 'activated') {
      throw new Error(`Plugin "${id}" is not activated (status=${instance.status})`);
    }

    // 1. 破缓存重载入口模块；失败 = 新代码有问题，旧版尚未动
    const definition = await this.loader.loadEntryModule<PluginDefinition>(instance.manifest, true);
    if (!definition) {
      throw new PluginReloadError(`plugin "${id}" new entry module failed to load`, true);
    }

    // 2. 装配配置（沿用 plugins.config.json 的 config 段）
    const pluginConfigs = await this.loader.loadPluginConfig();
    const configEntry = pluginConfigs[id];
    if (configEntry && configEntry.enabled === false) {
      throw new PluginReloadError(`plugin "${id}" is disabled by config, skip hot reload`, true);
    }
    const config = configEntry?.config ?? {};

    // 3. 构造新 instance（沿用 manifest，替换 definition；mcpServers 重置重新收集）
    const nextInstance: PluginInstance = {
      ...instance,
      definition,
      status: 'loaded',
      mcpServers: [],
    };
    const nextHyPlugin = this.wrapAsHyPlugin(nextInstance, config);

    // 4. 卸载旧版，挂载新版；失败则回滚旧版
    await this.host.unmount(id);
    try {
      await this.host.mount(nextHyPlugin);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 内核 mount 失败会**保留 error entry**（便于诊断的内核语义）——
      // 回滚挂载前必须先移除，否则 already mounted。
      await this.host.unmount(id).catch(() => {});
      try {
        const oldHyPlugin = this.wrapAsHyPlugin(instance, config);
        await this.host.mount(oldHyPlugin);
      } catch (rollbackError) {
        // 回滚也失败：宿主里已无该插件实现，簿记诚实化为 error
        // （loadAll 对 error 插件有重试语义；调用方应升级重启兜底）
        const rbMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        instance.status = 'error';
        instance.error = `hot reload rollback failed: ${rbMsg}`;
        this.plugins.set(id, instance);
        this.logger.error(
          'plugin reload failed AND rollback failed — plugin host unreliable, restart required',
          rollbackError instanceof Error ? rollbackError : new Error(rbMsg),
          { plugin: id },
        );
        throw new PluginReloadError(`plugin "${id}" reload and rollback both failed: ${msg}`, false);
      }
      instance.status = 'activated';
      this.plugins.set(id, instance);
      this.logger.warn('plugin reload failed, rolled back to previous version', { plugin: id });
      throw new PluginReloadError(`plugin "${id}" reload failed, rolled back: ${msg}`, true);
    }

    // 5. 成功：更新簿记为新版，并连接其注册的 MCP Server（幂等）
    nextInstance.status = 'activated';
    this.plugins.set(id, nextInstance);
    this.logger.info('plugin reloaded from disk', { plugin: id });
    await this.connectPluginMcpServers();
  }

  /** 获取内核插件宿主（供外部直接挂载内核级插件） */
  getHost(): PluginHost<Record<string, unknown>, LoopHooks> {
    return this.host;
  }

  // =============================================================
  // Internal — 发现与装载（保留原有逻辑）
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

  // =============================================================
  // Internal — 激活（委托 PluginHost）
  // =============================================================

  /**
   * 激活插件：将 PluginDefinition 包装为 HyPlugin，
   * 通过 PluginHost.mount 挂载，自动追踪所有注册项。
   */
  private async activatePlugin(
    instance: PluginInstance,
    config: Record<string, unknown>,
  ): Promise<void> {
    const { id } = instance.manifest;

    // configSchema 校验（manifest 或 definition 上的 schema）
    const schema = instance.manifest.configSchema ?? instance.definition.configSchema;
    if (schema) {
      const error = this.validateConfig(config, schema);
      if (error) {
        instance.status = 'error';
        instance.error = `Config validation failed: ${error}`;
        this.logger.error('config validation failed', new Error(error), { plugin: id });
        return;
      }
    }

    try {
      const hyPlugin = this.wrapAsHyPlugin(instance, config);
      await this.host.mount(hyPlugin);
      instance.status = 'activated';
      this.logger.info('activated', { plugin: id });
    } catch (error) {
      instance.status = 'error';
      instance.error = error instanceof Error ? error.message : String(error);
      this.logger.error(`failed to activate`, error instanceof Error ? error : new Error(String(error)), { plugin: id });
    }
  }

  /** 轻量 configSchema 校验（检查 required + type） */
  private validateConfig(
    config: Record<string, unknown>,
    schema: Record<string, unknown>,
  ): string | null {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = schema.required as string[] | undefined;

    if (required && Array.isArray(required)) {
      for (const key of required) {
        if (config[key] === undefined || config[key] === null) {
          return `missing required property "${key}"`;
        }
      }
    }

    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        const value = config[key];
        if (value === undefined || value === null) continue;

        const expectedType = propSchema.type as string | undefined;
        if (expectedType) {
          const actualType = typeof value;
          if (expectedType === 'array' && !Array.isArray(value)) {
            return `property "${key}" should be array, got ${actualType}`;
          } else if (expectedType !== 'array' && actualType !== expectedType) {
            return `property "${key}" should be ${expectedType}, got ${actualType}`;
          }
        }
      }
    }

    return null;
  }

  /**
   * 将旧 PluginDefinition 包装为 HyPlugin（C 拆出至 plugin-adapter.ts）。
   *
   * 核心变化：PluginApi 的 register/unregister 操作不再手动追踪，
   * 而是通过 PluginContext.add() 登记到 DisposableStore，
   * 卸载时自动逆序回滚。
   */
  private wrapAsHyPlugin(
    instance: PluginInstance,
    config: Record<string, unknown>,
  ): HyPlugin<Record<string, unknown>, LoopHooks> {
    return wrapAsHyPlugin({
      createApiWithAutoRollback: (inst, cfg, ctx) => this.createApiWithAutoRollback(inst, cfg, ctx),
      createApiForPlugin: (inst, cfg) => this.createApiForPlugin(inst, cfg),
      skillRegistry: this.deps.skillRegistry,
      contextComposer: this.deps.contextComposer,
    }, instance, config);
  }

  /**
   * 创建带自动回滚的 PluginApi。
   *
   * 与旧版不同：每个 register 调用都会在 ctx.add() 中登记一个
   * dispose 回调，PluginHost 卸载时自动逆序执行这些 dispose，
   * 无需手动维护 pluginRegistrations map。
   */
  private createApiWithAutoRollback(
    instance: PluginInstance,
    config: Record<string, unknown>,
    ctx: PluginContext<Record<string, unknown>, LoopHooks>,
  ): PluginApi {
    const pluginId = instance.manifest.id;
    const self = this;

    // 主循环钩子桥：把 PluginContext 的 onHook/aroundHook 透传给 PluginApi
    const hooksBridge = {
      onHook: (name: string, handler: (payload: unknown) => void | Promise<void>) => {
        ctx.onHook(name as never, handler as never);
      },
      aroundHook: (
        name: string,
        handler: (payload: unknown, next: (p: unknown) => Promise<unknown>) => Promise<unknown>,
      ) => {
        ctx.aroundHook(name as never, handler as never);
      },
    };

    return createPluginApi({
      pluginId,
      toolRegistry: this.deps.toolRegistry,
      skillRegistry: this.deps.skillRegistry,
      contextComposer: this.deps.contextComposer,
      pluginConfig: config,
      pendingMcpConfigs: this.pendingMcpConfigs,
      onServiceRegister: (key, service) => {
        // ctx.register：注册前值自动记录，插件卸载时恢复（热替换回滚语义）
        ctx.register(key as never, service as never);
      },
      onServiceGet: (key) => {
        // ctx.get：读取宿主服务表（其他插件/内核注册的服务），目录插件编排用
        return ctx.get(key as never);
      },
      onMcpServerRegister: (pid, mcpConfig) => {
        self.pendingMcpConfigs.push({ pluginId: pid, config: mcpConfig });
        instance.mcpServers.push(mcpConfig);
        ctx.add({
          dispose() {
            const idx = self.pendingMcpConfigs.findIndex(
              (c: { pluginId: string; config: { name: string } }) => c.pluginId === pid && c.config.name === mcpConfig.name,
            );
            if (idx >= 0) self.pendingMcpConfigs.splice(idx, 1);
          },
        });
      },
      onToolRegister: (name) => {
        ctx.add({
          dispose() {
            self.deps.toolRegistry.unregister(name);
          },
        });
      },
      onSkillRegister: (name) => {
        ctx.add({
          dispose() {
            self.deps.skillRegistry.unregister(name);
          },
        });
      },
      onContextSourceRegister: (name) => {
        ctx.add({
          dispose() {
            if ((self.deps.contextComposer as any).unregisterSource) {
              (self.deps.contextComposer as any).unregisterSource(name);
            }
          },
        });
      },
      onMcpServerUnregister: (name) => {
        const idx = this.pendingMcpConfigs.findIndex(
          (c) => c.pluginId === pluginId && c.config.name === name,
        );
        if (idx >= 0) this.pendingMcpConfigs.splice(idx, 1);
      },
      onChannelRegister: (handler: ChannelHandler, config?: ChannelConfig) => {
        if (this.deps.channelManager) {
          this.deps.channelManager.register(handler, config);
          ctx.add({
            dispose() {
              self.deps.channelManager?.unregister(handler.id);
            },
          });
          this.logger.info('plugin registered channel', { plugin: instance.manifest.id, channel: handler.id });
        } else {
          this.logger.warn('no ChannelManager available, channel not registered', { channel: handler.id });
        }
      },
      hooks: hooksBridge,
    });
  }

  /** 兼容旧路径：创建 PluginApi（不带自动回滚，用于 deactivate 回调） */
  private createApiForPlugin(
    instance: PluginInstance,
    config: Record<string, unknown>,
  ): PluginApi {
    return createPluginApi({
      pluginId: instance.manifest.id,
      toolRegistry: this.deps.toolRegistry,
      skillRegistry: this.deps.skillRegistry,
      contextComposer: this.deps.contextComposer,
      pluginConfig: config,
      pendingMcpConfigs: this.pendingMcpConfigs,
      onMcpServerRegister: (pid, mcpConfig) => {
        this.pendingMcpConfigs.push({ pluginId: pid, config: mcpConfig });
        instance.mcpServers.push(mcpConfig);
      },
      onServiceGet: (key) => {
        // deactivate 路径：仍从宿主服务表读取（卸载清理用；store.dispose 先于
        // deactivate，但他人注册的服务如 bypass.manager 仍在）
        return this.host.get(key as never);
      },
      onToolRegister: () => {},
      onSkillRegister: () => {},
      onContextSourceRegister: () => {},
      onMcpServerUnregister: () => {},
      onChannelRegister: (handler: ChannelHandler, config?: ChannelConfig) => {
        if (this.deps.channelManager) {
          this.deps.channelManager.register(handler, config);
        }
      },
    });
  }

  // =============================================================
  // Internal — MCP / Skill 注册
  // =============================================================

  /** 将插件注册的 MCP Server 统一委托 MCPSystem 管理 */
  private async connectPluginMcpServers(): Promise<void> {
    if (this.pendingMcpConfigs.length === 0) return;

    if (!this.deps.mcpSystem) {
      this.logger.warn('no MCPSystem available, skipping plugin MCP servers', { count: this.pendingMcpConfigs.length });
      return;
    }

    this.logger.info('delegating plugin MCP servers to MCPSystem', { count: this.pendingMcpConfigs.length });

    const configs = this.pendingMcpConfigs.map(({ config }) => config);
    await this.deps.mcpSystem.addExternalServers(configs, { isHotPlug: false });
  }

}
