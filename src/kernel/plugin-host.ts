import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';
import { HookBus } from './hook-bus.js';
import type { HookBusOptions, AnyHookHandler, Interceptor } from './hook-bus.js';
import { DisposableStore } from './types.js';
import type { Disposable, Disposer } from './types.js';

/**
 * 插件宿主 —— 内核的可插拔挂载面（重构方案 §2.2）。
 *
 * 三角色模型（Capability Seam，来自 DSH 报告 §4.1）：
 *   Service Definition（接口/键名，拥有 ctx.<key>）
 *     ▲ 插件 activate 时 register(key, impl)
 *   Service Provider（具体实现：deepseek / local / 某个 Router…）
 *     │ 被注入
 *   Consumer（AgentLoop、工具包…）通过 host.get(key) 消费
 *
 * 与现有 `plugins/manager.ts` 的关系：
 * - 本类是**内核原语**，只管生命周期与回滚，不关心 manifest / 目录扫描 / MCP 接线。
 * - 现有 PluginManager 在 P2 改造成构建于本类之上（保留它的发现与装载职责），
 *   P1 阶段两者并存，PluginManager 不动，避免一次性改动过大。
 */

/** 插件声明的服务表形状（由宿主的具体使用方给出） */
export type ServiceMap = Record<string, unknown>;

/**
 * 内核最小工具/上下文源结构（鸭子类型）——kernel 不依赖业务层类型，
 * 只按 name 做注册/注销簿记；业务字段由注入方自行保证。
 */
export interface HostToolLike {
  name: string;
}
export interface HostSourceLike {
  name: string;
}

/** 插件上下文 —— 插件唯一的能力入口 */
export interface PluginContext<S extends ServiceMap = ServiceMap, M extends Record<string, unknown> = Record<string, unknown>> {
  /** 插件 ID */
  readonly pluginId: string;
  /** 带插件 ID 上下文的日志器 */
  readonly logger: Logger;
  /** 插件自身配置（来自 plugins.config.json 的 config 段） */
  config<T = Record<string, unknown>>(): T;
  /** 登记资源：卸载时自动释放（工具、ContextSource、事件订阅、定时器…） */
  add(item: Disposable | Disposer): void;
// ── [圈三锚点 · 能力注册面] ──────────────────────────────────────────────
// 第三圈（联动清单 tool-links.json）接入时，改动落在这里：处理器能力注册（{id, kind, owner}）挂在这里；卸载自动回滚的语义已由本方法提供
// 触发条件：第二个真实联动用例出现（见 docs/design/tool-linkage-laws.md）
  /** 注册服务：卸载时自动恢复到注册前的值（支持热替换后回滚） */
  register<K extends keyof S>(key: K, service: S[K]): Disposable;
  /** 读取服务（不存在返回 undefined） */
  get<K extends keyof S>(key: K): S[K] | undefined;
  /** 读取服务（不存在抛错，用于强依赖） */
  require<K extends keyof S>(key: K): S[K];
  /**
   * 注册工具到 ToolRegistry（P3 能力注册；宿主构造时注入 registry 才可用，
   * 未注入时抛错）。返回 disposer：卸载时自动注销该工具。
   */
  registerTool(tool: HostToolLike): Disposable;
  /**
   * 注册 ContextSource（P3 能力注册；宿主构造时注入 composer 才可用，
   * 未注入时抛错）。返回 disposer：卸载时自动注销该源。
   */
  registerContextSource(source: HostSourceLike): Disposable;
  /** 主循环钩子总线（宿主构造时注入；未注入则为 undefined，此时 onHook 会抛错） */
  readonly hooks?: HookBus<M>;
  /**
   * 挂载主循环钩子 —— **推荐用法**。
   * 与 `ctx.hooks.on()` 的区别：本方法会把 disposer 一并登记进生命周期账本，
   * 插件卸载时钩子自动摘除，满足「卸载 → 功能消失」的验收条件。
   * 直接用 `ctx.hooks.on()` 则需要调用方自己 `ctx.add()` 保管 disposer。
   */
  onHook<K extends keyof M>(name: K, handler: AnyHookHandler<M[K]>): Disposable;
  /**
   * 包裹某个接缝 —— 可短路（不调 next）、可包裹（next 前后做事）、可改写。
   * 与 onHook 一样会把 disposer 登记进生命周期账本。
   */
  aroundHook<K extends keyof M>(name: K, handler: Interceptor<M[K]>): Disposable;
}

/** 插件定义 */
export interface HyPlugin<S extends ServiceMap = ServiceMap, M extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  /** 依赖的插件 ID —— mount 时校验，缺失直接报错而非运行时 undefined */
  deps?: string[];
  /** 激活：注册工具 / 服务 / 钩子。返回值会自动纳入生命周期管理 */
  activate(ctx: PluginContext<S, M>, config: unknown): void | Promise<void>;
  /** 停用：DisposableStore 释放之外的额外清理（可选） */
  deactivate?(): void | Promise<void>;
}

export type PluginState = 'mounted' | 'error';

interface PluginEntry {
  plugin: HyPlugin<never, never>;
  store: DisposableStore;
  state: PluginState;
  config: unknown;
  error?: string;
  /** 挂载序号：用于 dispose 时逆序卸载 */
  seq: number;
}

export interface PluginHostOptions<M extends Record<string, unknown>> {
  /** 主循环钩子总线（可选，注入后插件可通过 ctx.hooks 挂载钩子） */
  hooks?: HookBus<M>;
  /** 插件配置表：{ [pluginId]: config } */
  configs?: Record<string, unknown>;
  /** 工具注册表（可选；注入后插件可经 ctx.registerTool 注册工具，卸载自动注销） */
  toolRegistry?: {
    register(tool: HostToolLike): void;
    unregister(name: string): boolean;
  };
  /** 上下文组合器（可选；注入后插件可经 ctx.registerContextSource 注册源，卸载自动注销） */
  contextComposer?: {
    registerSource(source: HostSourceLike): void;
    unregisterSource(name: string): void;
  };
}

export class PluginHost<
  S extends ServiceMap = ServiceMap,
  M extends Record<string, unknown> = Record<string, unknown>,
> implements Disposable {
  private plugins = new Map<string, PluginEntry>();
  private services = new Map<keyof S, unknown>();
  private seq = 0;
  private readonly logger = createLogger('plugin-host');
  /** 主循环钩子总线 —— 可运行时注入（P6-1：不再要求构造期给定，宿主不因总线迟到而重建） */
  private hooks?: HookBus<M>;
  private readonly configs: Record<string, unknown>;
  private readonly toolRegistry?: { register(tool: HostToolLike): void; unregister(name: string): boolean };
  private readonly contextComposer?: { registerSource(source: HostSourceLike): void; unregisterSource(name: string): void };

  constructor(options: PluginHostOptions<M> = {}) {
    this.hooks = options.hooks;
    this.configs = options.configs ?? {};
    this.toolRegistry = options.toolRegistry;
    this.contextComposer = options.contextComposer;
  }

  /**
   * 运行时注入/切换主循环钩子总线（P6-1：取代「重建宿主」的注入方式）。
   *
   * 语义：**注入即切换，宿主不重建** —— 已挂载插件不丢失，宿主引用不变。
   * `ctx.hooks` 是延迟读 getter（见 createContext），`ctx.onHook/aroundHook`
   * 的方法体也在调用时读 `this.hooks`，因此注入后已挂载插件对新总线立即生效；
   * 唯一的硬约束是：**activate 期间调用 onHook 时总线须已注入**（否则按
   * noBusError 快速失败，显式报错而非静默丢失）。
   */
  setHooks(hooks: HookBus<M>): void {
    const had = this.hooks !== undefined;
    this.hooks = hooks;
    this.logger.info(had ? 'hook bus replaced' : 'hook bus injected');
  }

  // ─── 服务注册表（三角色中的 Definition + Provider 交汇点） ──────

  /** 读取服务（不存在返回 undefined） */
  get<K extends keyof S>(key: K): S[K] | undefined {
    return this.services.get(key) as S[K] | undefined;
  }

  /** 读取服务（不存在抛错） */
  require<K extends keyof S>(key: K): S[K] {
    const svc = this.services.get(key);
    if (svc === undefined) {
      throw new Error(`[plugin-host] required service "${String(key)}" is not registered`);
    }
    return svc as S[K];
  }

  /**
   * 直接注册服务（不经过插件）—— 内核自用的核心服务走这条路。
   * 返回 disposer：释放时**恢复注册前的值**（存在则恢复，不存在则删除），
   * 这是热替换后能回滚的关键。
   */
  register<K extends keyof S>(key: K, service: S[K]): Disposable {
    const had = this.services.has(key);
    const previous = this.services.get(key);
    this.services.set(key, service);
    return {
      dispose: () => {
        if (had) this.services.set(key, previous);
        else this.services.delete(key);
      },
    };
  }

  has(key: keyof S): boolean {
    return this.services.has(key);
  }

  // ─── 插件生命周期 ────────────────────────────────────────────────

  /** 挂载插件。返回 disposer（卸载 = dispose，等价于 unmount(id)） */
  async mount(plugin: HyPlugin<S, M>, config?: unknown): Promise<Disposable> {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`[plugin-host] plugin "${plugin.id}" is already mounted`);
    }

    for (const dep of plugin.deps ?? []) {
      const entry = this.plugins.get(dep);
      if (!entry) {
        throw new Error(`[plugin-host] plugin "${plugin.id}" requires missing dependency "${dep}"`);
      }
      if (entry.state === 'error') {
        throw new Error(`[plugin-host] plugin "${plugin.id}" dependency "${dep}" is in error state`);
      }
    }

    const store = new DisposableStore();
    const effectiveConfig = config ?? this.configs[plugin.id] ?? {};
    const entry: PluginEntry = {
      plugin: plugin as unknown as HyPlugin<never, never>,
      store,
      state: 'mounted',
      config: effectiveConfig,
      seq: this.seq++,
    };
    this.plugins.set(plugin.id, entry);

    const ctx = this.createContext(plugin.id, store, effectiveConfig);

    try {
      await plugin.activate(ctx as unknown as PluginContext<S, M>, effectiveConfig);
      this.logger.info(`plugin mounted: ${plugin.id}`);
    } catch (err) {
      // 激活失败：回滚已注册的一切，且**保留 error 条目**便于诊断
      entry.state = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      await store.dispose().catch(() => {});
      this.logger.error(`plugin activate failed: ${plugin.id}`, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    return {
      dispose: () => {
        void this.unmount(plugin.id);
      },
    };
  }

  /** 卸载插件：逆序释放自身资源 → 调用 deactivate → 摘除条目 */
  async unmount(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) return;
    this.plugins.delete(id);
    try {
      await entry.store.dispose();
      await entry.plugin.deactivate?.();
      this.logger.info(`plugin unmounted: ${id}`);
    } catch (err) {
      this.logger.error(`plugin unmount failed: ${id}`, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** 热重载：完整走「卸载 → 重新挂载」，配置可一并更新 */
  async reload(id: string, config?: unknown): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`[plugin-host] cannot reload unknown plugin "${id}"`);
    const nextConfig = config ?? entry.config;
    await this.unmount(id);
    await this.mount(entry.plugin as unknown as HyPlugin<S, M>, nextConfig);
  }

  isMounted(id: string): boolean {
    const entry = this.plugins.get(id);
    return !!entry && entry.state === 'mounted';
  }

  /** 已挂载插件概览（诊断 / UI 状态展示用） */
  list(): Array<{ id: string; state: PluginState; error?: string; deps: string[] }> {
    return [...this.plugins.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({
        id: e.plugin.id,
        state: e.state,
        ...(e.error ? { error: e.error } : {}),
        deps: e.plugin.deps ?? [],
      }));
  }

  /** 逆序卸载全部插件（kernel 关闭时调用） */
  async dispose(): Promise<void> {
    const ids = [...this.plugins.values()]
      .sort((a, b) => b.seq - a.seq)
      .map((e) => e.plugin.id);
    for (const id of ids) {
      await this.unmount(id).catch(() => {});
    }
    this.services.clear();
  }

  // ─── 内部 ────────────────────────────────────────────────────────

  private createContext(pluginId: string, store: DisposableStore, config: unknown): PluginContext<S, M> {
    const logger = this.logger.child('mod', { plugin: pluginId });
    const self = this;
    return {
      pluginId,
      logger,
      config: <T = Record<string, unknown>>(): T => config as T,
      add: (item) => {
        store.add(item as Disposable);
      },
      register: (key, service) => store.add(this.register(key, service)),
      get: (key) => this.get(key),
      require: (key) => this.require(key),
      registerTool: (tool) => {
        if (!this.toolRegistry) throw this.noCapabilityError(pluginId, 'registerTool');
        this.toolRegistry.register(tool);
        return store.add({
          dispose: () => { this.toolRegistry?.unregister(tool.name); },
        });
      },
      registerContextSource: (source) => {
        if (!this.contextComposer) throw this.noCapabilityError(pluginId, 'registerContextSource');
        this.contextComposer.registerSource(source);
        return store.add({
          dispose: () => { this.contextComposer?.unregisterSource(source.name); },
        });
      },
      onHook: (name, handler) => {
        if (!this.hooks) throw this.noBusError(pluginId, String(name), 'onHook');
        return store.add(this.hooks.on(name, handler));
      },
      aroundHook: (name, handler) => {
        if (!this.hooks) throw this.noBusError(pluginId, String(name), 'aroundHook');
        return store.add(this.hooks.intercept(name, handler));
      },
      // P6-1：延迟读 getter（而非构造时快照）—— 总线后注入时，已挂载插件的
      // ctx.hooks 立即指向新总线；未注入时为 undefined（内核可无总线运行）。
      get hooks(): HookBus<M> | undefined { return self.hooks; },
    };
  }

  private noBusError(pluginId: string, name: string, method: string): Error {
    return new Error(
      `[plugin-host] plugin "${pluginId}" called ${method}("${name}") but the host has no hook bus`,
    );
  }

  private noCapabilityError(pluginId: string, method: string): Error {
    return new Error(
      `[plugin-host] plugin "${pluginId}" called ${method}() but the host was not wired with the required registry`,
    );
  }
}

/** 便捷：创建带默认异常日志的钩子总线 */
export function createHookBus<M extends Record<string, unknown>>(options?: HookBusOptions): HookBus<M> {
  return new HookBus<M>(options);
}
