/**
 * ## 热加载管理器 — 热加载原则
 *
 * 项目设计原则：配置变更应即时生效，不重启。
 * 所有外部化内容（MCP、Skill、Agent、Workflow、Provider、Config 等）
 * 均通过各自的 watcher 监听文件变化，自动重载。
 *
 * 已使用 fs.watchFile（stat 轮询）替代 fs.watch：
 *   - .agent/ 目录文件密集（session、SQLite、scheduler），fs.watch 在 Windows 上性能差
 *   - 用 5s 间隔 stat 轮询，对极少变更的配置文件影响更小
 *
 * 新增热加载项：
 *   1. 在对应目录写 watcher 模块（参考 mcp-watcher.ts / provider-watcher.ts）
 *   2. 在此文件的 start() 中注册（带 config guard）
 *   3. 确保 watcher 返回 handle 数组，stop() 会统一 close
 */
import type { ToolRegistry } from '../tools/registry.js';
import type { SkillDefinition } from '../types.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { WorkflowRegistry } from '../workflow/registry.js';
import type { WorkflowDefinition } from '../workflow/types.js';
import type { PluginManager } from '../plugins/manager.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { MCPSystem } from '../mcp/system.js';
import type { ProviderConfigLoader } from '../provider/config.js';
import type { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import type { ModelCatalog } from '../provider/catalog.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { createLogger } from '../logging/logger.js';

// ─── Types ────────────────────────────────────────────────────────

export interface HotReloadDeps {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
  workflowRegistry: WorkflowRegistry;
  pluginManager: PluginManager;
  configCenter: RuntimeConfigCenter;
  contextComposer: LayeredContextComposer;
  mcpSystem: MCPSystem;
  bundleRegistry: ToolBundleRegistry;
  channelRegistry?: ModelChannelRegistry;
  cwd: string;
  providerConfigLoader: ProviderConfigLoader;
  modelCatalog: ModelCatalog;
}

// ─── HotReloadManager ─────────────────────────────────────────────

export class HotReloadManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private watchers: any[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private logger = createLogger('hot-reload:manager');
  private started = false;

  constructor(private deps: HotReloadDeps) {}

  // ── Static factory ──

  static create(cwd: string, deps: HotReloadDeps): HotReloadManager {
    const manager = new HotReloadManager(deps);
    manager.start();
    return manager;
  }

  // ── Lifecycle ──

  start(): void {
    if (this.started) return;

    const enabled = this.deps.configCenter.get<boolean>('hotReload.enabled');
    if (!enabled) {
      this.logger.info('Hot reload is disabled via config');
      return;
    }

    const debounceMs = this.deps.configCenter.get<number>('hotReload.debounceMs') ?? 300;

    this.logger.info('Starting hot reload watchers...');

    // ── MCP config watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchMcp')) {
      import('./mcp-watcher.js').then(({ watchMcpConfig }) => {
        this.registerWatcher(watchMcpConfig, {
          mcpSystem: this.deps.mcpSystem,
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load MCP watcher', { error: (err as Error).message });
      });
    }

    // ── Plugin watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchPlugins')) {
      import('./plugin-watcher.js').then(({ watchPluginsDir }) => {
        this.registerWatcher(watchPluginsDir, {
          pluginManager: this.deps.pluginManager,
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load plugin watcher', { error: (err as Error).message });
      });
    }

    // ── Prompt watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchPrompts')) {
      import('./prompt-watcher.js').then(({ watchPrompts }) => {
        this.registerWatcher(watchPrompts, { debounceMs });
      }).catch((err) => {
        this.logger.warn('Failed to load prompt watcher', { error: (err as Error).message });
      });
    }

    // ── Agent watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchAgents')) {
      import('./agent-watcher.js').then(({ watchAgentsJson }) => {
        this.registerWatcher(watchAgentsJson, {
          agentRegistry: this.deps.agentRegistry,
          contextComposer: this.deps.contextComposer,
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load agent watcher', { error: (err as Error).message });
      });
    }

    // ── Config watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchConfig')) {
      import('./config-watcher.js').then(({ watchConfigJson }) => {
        this.registerWatcher(watchConfigJson, {
          configCenter: this.deps.configCenter,
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load config watcher', { error: (err as Error).message });
      });
    }

    // ── Tool watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchTools')) {
      import('./tool-watcher.js').then(({ watchTools }) => {
        this.registerWatcher(watchTools, {
          toolRegistry: this.deps.toolRegistry,
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load tool watcher', { error: (err as Error).message });
      });
    }

    // ── Skill watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchSkills')) {
      import('./skill-watcher.js').then(({ watchSkills }) => {
        this.registerWatcher(watchSkills, {
          skillRegistry: this.deps.skillRegistry,
          cwd: this.deps.cwd,
          debounceMs,
          onSkillLoaded: (skill: SkillDefinition) => {
            // 文件 skill 热加载后补注册 lazy_expand ContextSource
            this.deps.contextComposer.registerSource({
              name: `skill-${skill.name}`,
              strategy: 'lazy_expand',
              cacheability: 'manifest',
              description: skill.description,
              getContent: () => {
                const s = this.deps.skillRegistry.get(skill.name);
                return s ? this.deps.skillRegistry.getFullDefinitions([skill.name]) : '';
              },
            });
          },
        });
      }).catch((err) => {
        this.logger.warn('Failed to load skill watcher', { error: (err as Error).message });
      });
    }

    // ── Workflow watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchWorkflows') !== false) {
      import('./workflow-watcher.js').then(({ watchWorkflows }) => {
        this.registerWatcher(watchWorkflows, {
          workflowRegistry: this.deps.workflowRegistry,
          cwd: this.deps.cwd,
          debounceMs,
          onWorkflowLoaded: (wf: WorkflowDefinition) => {
            // 文件 workflow 热加载后补注册 lazy_expand ContextSource
            this.deps.contextComposer.registerSource({
              name: `workflow-${wf.name}`,
              strategy: 'lazy_expand',
              cacheability: 'manifest',
              description: wf.description,
              getContent: () => {
                const w = this.deps.workflowRegistry.get(wf.name);
                return w ? this.deps.workflowRegistry.getFullDefinitions([wf.name]) : '';
              },
            });
          },
        });
      }).catch((err) => {
        this.logger.warn('Failed to load workflow watcher', { error: (err as Error).message });
      });
    }

    // ── Slash commands watcher（commands.json 外部配置，模型可写） ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchCommands') !== false) {
      import('./command-watcher.js').then(({ watchCommandsJson }) => {
        this.registerWatcher(watchCommandsJson, {
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load command watcher', { error: (err as Error).message });
      });
    }

    // ── Provider config watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchProviders')) {
      import('./provider-watcher.js').then(({ watchProviderConfig }) => {
        this.registerWatcher(watchProviderConfig, {
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load provider watcher', { error: (err as Error).message });
      });
    }

    // ── Model catalog watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchModelCatalog')) {
      import('./model-catalog-watcher.js').then(({ watchModelCatalogConfig }) => {
        this.registerWatcher(watchModelCatalogConfig, {
          cwd: this.deps.cwd,
          debounceMs,
          configCenter: this.deps.configCenter,
          currentModel: () => {
            const provider = this.deps.configCenter.get<string>('session.provider');
            const model = this.deps.configCenter.get<string>('session.model');
            if (!provider) return undefined;
            return { provider, model: model ?? '' };
          },
        });
      }).catch((err) => {
        this.logger.warn('Failed to load model catalog watcher', { error: (err as Error).message });
      });
    }

    // ── Context manifest watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchContextManifest') !== false) {
      import('./manifest-watcher.js').then(({ watchContextManifest }) => {
        this.registerWatcher(watchContextManifest, {
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load manifest watcher', { error: (err as Error).message });
      });
    }

    // ── Tool bundle watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchBundles') !== false) {
      import('./bundle-watcher.js').then(({ watchBundles }) => {
        this.registerWatcher(watchBundles, {
          registry: this.deps.bundleRegistry!,
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load bundle watcher', { error: (err as Error).message });
      });
    }

    // ── Model channel watcher ──
    if (this.deps.configCenter.get<boolean>('hotReload.watchProviders') && this.deps.channelRegistry) {
      import('./channel-watcher.js').then(({ watchModelChannels }) => {
        this.registerWatcher(watchModelChannels, {
          channelRegistry: this.deps.channelRegistry!,
          cwd: this.deps.cwd,
          debounceMs,
        });
      }).catch((err) => {
        this.logger.warn('Failed to load channel watcher', { error: (err as Error).message });
      });
    }

    this.started = true;
    this.logger.info('Hot reload watchers registered');
  }

  stop(): void {
    this.logger.info('Stopping hot reload watchers...');

    // Close all watcher instances (FSWatcher / StatWatcher / custom handles)
    for (const watcher of this.watchers) {
      if (typeof watcher?.close === 'function') watcher.close();
    }
    this.watchers = [];

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.started = false;
    this.logger.info('Hot reload stopped');
  }

  // ── Helpers ──

  /**
   * Call a watcher factory function and store the returned FSWatcher(s).
   * Handles both single FSWatcher and FSWatcher[] return values.
   */
  registerWatcher(
    fn: (...args: any[]) => any,
    ...args: unknown[]
  ): void {
    try {
      const result = fn(...args);
      if (Array.isArray(result)) {
        for (const w of result) {
          this.watchers.push(w);
        }
        this.logger.debug('Watchers registered', { count: result.length, total: this.watchers.length });
      } else if (result) {
        this.watchers.push(result);
        this.logger.debug('Watcher registered', { total: this.watchers.length });
      }
    } catch (err) {
      this.logger.error('Failed to register watcher', err instanceof Error ? err : new Error(String(err)));
    }
  }
}