import { MCPConfigLoader } from './config.js';
import { MCPServerManager } from './lifecycle.js';
import { MCPBridge } from './bridge.js';
import { MCPInstallManager } from './install-manager.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { LifecycleSupervisor } from '../lifecycle/supervisor.js';
import type { MCPConfig } from '../types.js';
import { createLogger } from '../logging/logger.js';

export interface MCPStatusEvent {
  type: 'added' | 'removed' | 'failed';
  name: string;
  tools?: string[];
}

export interface MCPSystemDeps {
  cwd: string;
  logger?: ReturnType<typeof createLogger>;
}

interface MCPServerStatus {
  name: string;
  connected: boolean;
}

/**
 * MCPSystem — MCP 模块统一管理器
 *
 * 对标 PluginManager 的管理模式，封装 MCP 的完整生命周期：
 *   - start(): 加载配置 → 连接所有 MCP Server → 注册工具/ContextSource/Supervisor
 *   - stop(): 断开所有 MCP Server
 *   - reload(): 热加载，增量增/删/改 MCP Server
 *
 * 所有 MCP Server 随主进程启动而启动，随主进程关闭而关闭。
 */
export class MCPSystem {
  private managers: MCPServerManager[] = [];
  private installManager: MCPInstallManager;
  private bridge: MCPBridge;
  private configLoader: MCPConfigLoader;
  private currentConfigs: MCPConfig[] = [];
  private cwd: string;
  private logger: ReturnType<typeof createLogger>;

  private statusCallback?: (event: MCPStatusEvent) => void;

  // 外部依赖（通过 register 方法注入）
  private toolRegistry?: ToolRegistry;
  private contextComposer?: LayeredContextComposer;
  private supervisor?: LifecycleSupervisor;

  constructor(deps: MCPSystemDeps) {
    this.cwd = deps.cwd;
    this.logger = deps.logger ?? createLogger('mcp:system');
    this.configLoader = new MCPConfigLoader();
    this.installManager = new MCPInstallManager();
    this.bridge = new MCPBridge([]);
  }

  /** 启动所有 MCP Server */
  async start(): Promise<void> {
    this.currentConfigs = await this.configLoader.load(this.cwd);

    for (const config of this.currentConfigs) {
      await this.addServer(config);
    }

    this.logger.info(`MCPSystem started: ${this.managers.length}/${this.currentConfigs.length} servers connected`);
  }

  /** 停止所有 MCP Server */
  async stop(): Promise<void> {
    for (const manager of this.managers) {
      try {
        await manager.disconnect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`disconnect error for ${manager.getName()}: ${msg}`);
      }
    }
    this.managers = [];
    this.bridge.updateClients([], []);
    this.currentConfigs = [];
    this.logger.info('MCPSystem stopped');
  }

  /** 热加载重载 */
  async reload(): Promise<void> {
    const newConfigs = await this.configLoader.load(this.cwd);

    const oldMap = new Map(this.currentConfigs.map(c => [c.name, c]));
    const newMap = new Map(newConfigs.map(c => [c.name, c]));

    // Added — 热插拔：新增 Server 标记 isHotPlug，ContextSource 进 Zone 5 临时区
    for (const [name, cfg] of newMap) {
      if (!oldMap.has(name)) {
        this.logger.info('MCP server added (hot-plug)', { name });
        await this.addServer(cfg, { isHotPlug: true });
      }
    }

    // Removed
    for (const [name] of oldMap) {
      if (!newMap.has(name)) {
        this.logger.info('MCP server removed', { name });
        await this.removeServer(name);
      }
    }

    // Changed — 热插拔：先 remove 再 add，新实例也标记 isHotPlug
    for (const [name, newCfg] of newMap) {
      const oldCfg = oldMap.get(name);
      if (oldCfg && !configsEqual(oldCfg, newCfg)) {
        this.logger.info('MCP server changed (hot-plug)', { name });
        await this.removeServer(name);
        await this.addServer(newCfg, { isHotPlug: true });
      }
    }

    this.currentConfigs = newConfigs;
    this.logger.info(`MCPSystem reloaded: ${this.managers.length} servers`);
  }

  /** 注册到 ToolRegistry */
  registerToToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
    this.bridge.registerToRegistry(registry);
  }

  /** 注册到 ContextComposer — 每个 Server 注册为独立 ContextSource */
  registerToContextComposer(composer: LayeredContextComposer): void {
    this.contextComposer = composer;
    this.syncContextSources(composer);
  }

  /** 注册到 LifecycleSupervisor */
  registerToLifecycleSupervisor(supervisor: LifecycleSupervisor): void {
    this.supervisor = supervisor;
    for (const manager of this.managers) {
      supervisor.registerMCPServer(manager.getProcessManager());
    }
  }

  /** 获取 MCPBridge 实例 */
  getBridge(): MCPBridge {
    return this.bridge;
  }

  /** 获取所有 Manager */
  getManagers(): MCPServerManager[] {
    return this.managers;
  }

  /** 获取所有 MCP Server 状态 */
  getStatus(): MCPServerStatus[] {
    return this.managers.map(m => ({
      name: m.getName(),
      connected: m.isConnected(),
    }));
  }

  /** 注册状态变更回调 */
  onStatusChange(cb: (event: MCPStatusEvent) => void): void {
    this.statusCallback = cb;
  }

  /** 触发状态变更事件 */
  private emitStatus(event: MCPStatusEvent): void {
    this.statusCallback?.(event);
    this.logger.info(`MCP status: ${event.type}`, { name: event.name, tools: event.tools?.join(',') });
  }

  /**
   * 添加外部来源的 MCP Server（如插件注册）。
   * 与 mcp.json 配置的 Server 统一走 addServer 路径，享受相同的生命周期管理、热插拔缓存策略和优雅关闭保护。
   */
  async addExternalServer(config: MCPConfig, opts?: { isHotPlug?: boolean }): Promise<void> {
    await this.addServer(config, opts);
  }

  /**
   * 批量添加外部 MCP Server 配置。用于 PluginManager 统一注册插件声明的 MCP。
   */
  async addExternalServers(configs: MCPConfig[], opts?: { isHotPlug?: boolean }): Promise<void> {
    for (const config of configs) {
      await this.addServer(config, opts);
    }
  }

  /**
   * 按名称移除 Server（外部调用）。PluginManager 在 deactivate 插件时使用。
   */
  async removeExternalServer(name: string): Promise<void> {
    await this.removeServer(name);
  }

  // ── 内部方法 ──

  /** 添加单个 MCP Server。isHotPlug=true 时 ContextSource 使用 live 缓存策略（进 Zone 5），避免破坏 Zone 2-3 前缀缓存。 */
  private async addServer(config: MCPConfig, opts: { isHotPlug?: boolean } = {}): Promise<void> {
    const isHotPlug = opts.isHotPlug ?? false;

    // 安装管理：确保包已安装，更新 command/args
    const resolved = await this.installManager.ensureInstalled(config);
    if (resolved === null && config.packageType) {
      this.logger.warn(`MCP server "${config.name}" install failed, skipping`);
      return;
    }
    const effectiveConfig = resolved ? { ...config, command: resolved.command, args: resolved.args } : config;

    const manager = new MCPServerManager(effectiveConfig);
    const ok = await manager.connect();
    if (!ok) {
      this.logger.warn(`MCP server "${config.name}" connect failed, skipping`);
      // 连接失败时清理子进程
      try {
        await manager.disconnect();
      } catch {
        // 忽略断开连接时的错误
      }
      this.emitStatus({ type: 'failed', name: config.name });
      return;
    }

    this.managers.push(manager);
    this.syncBridge();

    // 注册到 ToolRegistry
    if (this.toolRegistry) {
      this.bridge.registerToRegistry(this.toolRegistry);
    }

    // 注册到 ContextComposer — 热插拔与持久化使用不同 cacheability
    if (this.contextComposer) {
      this.registerServerContextSource(config.name, manager, this.contextComposer, isHotPlug);
    }

    // 注册到 LifecycleSupervisor
    if (this.supervisor) {
      this.supervisor.registerMCPServer(manager.getProcessManager());
    }

    this.emitStatus({ type: 'added', name: config.name, tools: manager.getClient().getTools().map(t => t.name) });
  }

  /** 移除单个 MCP Server */
  private async removeServer(name: string): Promise<void> {
    const idx = this.managers.findIndex(m => m.getName() === name);
    if (idx === -1) return;

    const manager = this.managers[idx];
    const oldToolNames = manager.getClient().getTools().map(t => t.name);

    // 注销工具
    if (this.toolRegistry) {
      this.bridge.unregisterTools(name, this.toolRegistry);
    }

    // 注销 ContextSource
    if (this.contextComposer) {
      this.contextComposer.unregisterSource(`mcp-${name}`);
    }

    // 断开连接
    try {
      await manager.disconnect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`disconnect error for ${name}: ${msg}`);
    }

    this.managers.splice(idx, 1);
    this.syncBridge();

    this.emitStatus({ type: 'removed', name, tools: oldToolNames });
  }

  /** 同步 MCPBridge 的 clients/managers 列表 */
  private syncBridge(): void {
    const clients = this.managers.map(m => m.getClient());
    this.bridge.updateClients(clients, this.managers);
  }

  /** 同步所有 ContextSource */
  private syncContextSources(composer: LayeredContextComposer): void {
    for (const manager of this.managers) {
      this.registerServerContextSource(manager.getName(), manager, composer);
    }
  }

  /** 注册单个 Server 的 ContextSource。isHotPlug 时用 live 策略（进 Zone 5 临时区），否则用 manifest 策略（进 Zone 2 稳定前缀）。 */
  private registerServerContextSource(
    name: string,
    manager: MCPServerManager,
    composer: LayeredContextComposer,
    isHotPlug = false,
  ): void {
    const client = manager.getClient();
    composer.registerSource({
      name: `mcp-${name}`,
      strategy: 'index_only',
      cacheability: isHotPlug ? 'live' : 'manifest',
      description: `${name}: ${client.getTools().map(t => t.name).join(', ')}`,
      getContent: () => client.getToolIndex(),
    });
  }
}

// ── 比较两个 MCPConfig 是否相等 ──
function configsEqual(a: MCPConfig, b: MCPConfig): boolean {
  return (
    a.command === b.command &&
    arrayEqualUnordered(a.args, b.args) &&
    a.url === b.url &&
    objectEqual(a.env, b.env) &&
    objectEqual(a.headers, b.headers) &&
    a.packageType === b.packageType &&
    a.package === b.package &&
    a.packageVersion === b.packageVersion &&
    a.connectTimeout === b.connectTimeout &&
    a.callTimeout === b.callTimeout
  );
}

function arrayEqualUnordered(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function objectEqual(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, i) => key === keysB[i] && a[key] === b[key]);
}
