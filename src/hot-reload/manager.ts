/**
 * ## 热加载管理器 — 热加载原则
 *
 * 项目设计原则：配置变更应即时生效，不重启。
 * 所有外部化内容（MCP、Skill、Agent、Workflow、Provider、Config 等）
 * 均通过各自的 watcher 监听文件变化，自动重载。
 *
 * 监听方式：独立配置文件多数走 poll（fs.watchFile stat 轮询，.agent/
 * 目录文件密集，fs.watch 在 Windows 上误触发多）；目录递归走 watch。
 * 骨架细节见 watcher-base.ts。
 *
 * 新增热加载项：
 *   1. 在对应目录写 watcher 模块（返回 WatcherHandle[]）
 *   2. 在 watcherSpecs() 表中加一条 { flag, load, build }
 *   3. 确保 flag 对应 configCenter 的 hotReload.* 开关
 */
import type { ToolRegistry } from '../tools/registry.js';
import type { SkillDefinition } from '../types.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { PluginManager } from '../plugins/manager.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { MCPSystem } from '../mcp/system.js';
import type { ProviderConfigLoader } from '../provider/config.js';
import type { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import type { ModelCatalog } from '../provider/catalog.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { createLogger } from '../logging/logger.js';
import type { WatcherHandle } from './watcher-base.js';
import type { ExtensionRegistry } from '../supervisor/extension-registry.js';
import type { ManifestAccessLike } from './extension-registry-watcher.js';

// ─── Types ────────────────────────────────────────────────────────

export interface HotReloadDeps {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
  pluginManager: PluginManager;
  configCenter: RuntimeConfigCenter;
  contextComposer: LayeredContextComposer;
  mcpSystem: MCPSystem;
  bundleRegistry: ToolBundleRegistry;
  channelRegistry?: ModelChannelRegistry;
  /** 架构监督（扩展注册表方案）：名单 watcher 的运行时注册表（未装配则跳过注册） */
  extensionRegistry?: ExtensionRegistry;
  /** 名单访问面（gateway 注入 arch-assembly.createManifestAccess；与 extensionRegistry 成对出现） */
  manifestAccess?: ManifestAccessLike;
  cwd: string;
  providerConfigLoader: ProviderConfigLoader;
  modelCatalog: ModelCatalog;
}

/** 单个 watcher 的装配条目：config 开关 → 动态加载 → 传参构造 */
interface WatcherSpecEntry {
  /** configCenter 开关键（hotReload.*）；undefined = 默认启用 */
  flag?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load: () => Promise<{ watch: (...args: any[]) => WatcherHandle[] | WatcherHandle }>;
  /** 构造 watcher 参数；返回 null 表示前置条件不满足（跳过注册） */
  build: (d: HotReloadDeps, debounceMs: number) => unknown[] | null;
}

// ─── HotReloadManager ─────────────────────────────────────────────

export class HotReloadManager {
  private handles: WatcherHandle[] = [];
  private logger = createLogger('hot-reload:manager');
  private started = false;

  constructor(private deps: HotReloadDeps) {}

  // ── Static factory ──

  static create(cwd: string, deps: HotReloadDeps): HotReloadManager {
    const manager = new HotReloadManager(deps);
    manager.start();
    return manager;
  }

  // ── Watcher 装配表（13 个 watcher 的注册配置；防屎山核心） ──

  private watcherSpecs(): WatcherSpecEntry[] {
    return [
      {
        flag: 'hotReload.watchMcp',
        load: () => import('./mcp-watcher.js').then((m) => ({ watch: m.watchMcpConfig })),
        build: (d, ms) => [{ mcpSystem: d.mcpSystem, cwd: d.cwd, debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchPlugins',
        load: () => import('./plugin-watcher.js').then((m) => ({ watch: m.watchPluginsDir })),
        build: (d, ms) => [{ pluginManager: d.pluginManager, cwd: d.cwd, debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchPrompts',
        load: () => import('./prompt-watcher.js').then((m) => ({ watch: m.watchPrompts })),
        build: (_d, ms) => [{ debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchAgents',
        load: () => import('./agent-watcher.js').then((m) => ({ watch: m.watchAgentsJson })),
        build: (d, ms) => [{ agentRegistry: d.agentRegistry, contextComposer: d.contextComposer, cwd: d.cwd, debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchConfig',
        load: () => import('./config-watcher.js').then((m) => ({ watch: m.watchConfigJson })),
        build: (d, ms) => [{ configCenter: d.configCenter, cwd: d.cwd, debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchTools',
        load: () => import('./tool-watcher.js').then((m) => ({ watch: m.watchTools })),
        build: (d, ms) => [{ toolRegistry: d.toolRegistry, cwd: d.cwd, debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchSkills',
        load: () => import('./skill-watcher.js').then((m) => ({ watch: m.watchSkills })),
        build: (d, ms) => [{
          skillRegistry: d.skillRegistry,
          cwd: d.cwd,
          debounceMs: ms,
          onSkillLoaded: (skill: SkillDefinition) => {
            // 文件 skill 热加载后补注册 lazy_expand ContextSource
            d.contextComposer.registerSource({
              name: `skill-${skill.name}`,
              strategy: 'lazy_expand',
              cacheability: 'manifest',
              description: skill.description,
              getContent: () => {
                const s = d.skillRegistry.get(skill.name);
                return s ? d.skillRegistry.getFullDefinitions([skill.name]) : '';
              },
            });
          },
        }],
      },
      {
        // watchCommands 原语义为 !== false（缺省启用）
        flag: 'hotReload.watchCommands',
        load: () => import('./command-watcher.js').then((m) => ({ watch: m.watchCommandsJson })),
        build: (d, ms) => [{ cwd: d.cwd, debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchProviders',
        load: () => import('./provider-watcher.js').then((m) => ({ watch: m.watchProviderConfig })),
        build: (d, ms) => [{ cwd: d.cwd, debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchModelCatalog',
        load: () => import('./model-catalog-watcher.js').then((m) => ({ watch: m.watchModelCatalogConfig })),
        build: (d, ms) => [{
          cwd: d.cwd,
          debounceMs: ms,
          configCenter: d.configCenter,
          currentModel: () => {
            const provider = d.configCenter.get<string>('session.provider');
            const model = d.configCenter.get<string>('session.model');
            if (!provider) return undefined;
            return { provider, model: model ?? '' };
          },
        }],
      },
      {
        // watchContextManifest 原语义为 !== false（缺省启用）
        flag: 'hotReload.watchContextManifest',
        load: () => import('./manifest-watcher.js').then((m) => ({ watch: m.watchContextManifest })),
        build: (d, ms) => [{ cwd: d.cwd, debounceMs: ms }],
      },
      {
        flag: 'hotReload.watchBundles',
        load: () => import('./bundle-watcher.js').then((m) => ({ watch: m.watchBundles })),
        build: (d, ms) => [{ registry: d.bundleRegistry, cwd: d.cwd, debounceMs: ms }],
      },
      {
        // 架构监督：名单文件变化 → 重新裁决（插件启停即改即生效）；
        // extensionRegistry 未装配时 build 返回 null 跳过注册
        flag: 'hotReload.watchExtensionRegistry',
        load: () => import('./extension-registry-watcher.js').then((m) => ({ watch: m.watchExtensionRegistry })),
        build: (d, ms) =>
          d.extensionRegistry && d.manifestAccess
            ? [{ extensionRegistry: d.extensionRegistry, pluginManager: d.pluginManager, manifestAccess: d.manifestAccess, debounceMs: ms }]
            : null,
      },
      {
        // channel watcher 与 provider watcher 共用同一开关；
        // channelRegistry 未装配时 build 返回 null 跳过注册
        flag: 'hotReload.watchProviders',
        load: () => import('./channel-watcher.js').then((m) => ({ watch: m.watchModelChannels })),
        build: (d, ms) =>
          d.channelRegistry
            ? [{ channelRegistry: d.channelRegistry, cwd: d.cwd, debounceMs: ms }]
            : null,
      },
    ];
  }

  // ── Lifecycle ──

  start(): void {
    if (this.started) return;

    const enabled = this.deps.configCenter.get<boolean>('hotReload.enabled');
    if (!enabled) {
      this.logger.info('Hot reload is disabled via config');
      return;
    }

    const debounceMs = this.deps.configCenter.get<number>('hotReload.debounceMs') ?? 500;
    this.logger.info('Starting hot reload watchers...');

    for (const spec of this.watcherSpecs()) {
      // get() 已合并 defaults（watchCommands/watchContextManifest 缺省 true 由 defaults 承担），
      // 用户显式 false 才跳过注册
      if (spec.flag && !this.deps.configCenter.get<boolean>(spec.flag)) {
        continue;
      }

      spec
        .load()
        .then((mod) => {
          const args = spec.build(this.deps, debounceMs);
          if (args === null) return; // 前置条件不满足（如 channelRegistry 缺失）
          this.registerWatcher(mod.watch, ...args);
        })
        .catch((err) => {
          this.logger.warn('Failed to load watcher', { error: (err as Error).message });
        });
    }

    this.started = true;
    this.logger.info('Hot reload watchers registered');
  }

  stop(): void {
    this.logger.info('Stopping hot reload watchers...');

    for (const handle of this.handles) {
      try { handle.close(); } catch { /* 句柄可能已失效 */ }
    }
    this.handles = [];

    this.started = false;
    this.logger.info('Hot reload stopped');
  }

  /** 运行状态（Supervisor 方案 S5：可观测面数据源） */
  getStatus(): { started: boolean; watcherCount: number; debounceMs: number } {
    return {
      started: this.started,
      watcherCount: this.handles.length,
      debounceMs: this.deps.configCenter.get<number>('hotReload.debounceMs') ?? 500,
    };
  }

  // ── Helpers ──

  /** 调用 watcher 工厂并登记句柄（单句柄与数组统一处理） */
  registerWatcher(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (...args: any[]) => WatcherHandle[] | WatcherHandle,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ): void {
    try {
      const result = fn(...args);
      const list = Array.isArray(result) ? result : [result];
      this.handles.push(...list);
      this.logger.debug('Watchers registered', { count: list.length, total: this.handles.length });
    } catch (err) {
      this.logger.error('Failed to register watcher', err instanceof Error ? err : new Error(String(err)));
    }
  }
}
