/**
 * 插件适配层（C 拆出）——把目录插件（PluginDefinition）适配为内核 HyPlugin。
 *
 * 原为 manager.ts 的私有方法 wrapAsHyPlugin（~45 行）+ 技能扫描段。
 * 抽取动机：让「目录插件 → 可直接挂到 PluginHost 的 HyPlugin」成为独立可测模块，
 * loader 经此产出 HyPlugin，manager 只保留 api 工厂与状态簿记。
 * 行为零变更：纯搬移，`mgr.deps` 参数化为 deps。
 */
import type { PluginDefinition, PluginInstance } from './types.js';
import type { PluginApi } from './types.js';
import type { HyPlugin, PluginContext } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import type { ContextSource } from '../context/interface.js';

/** 适配层依赖：仅需要 api 工厂 + 技能注册表（用于扫描插件自带 skill 挂 ContextSource） */
export interface PluginAdapterDeps {
  /** 创建带自动回滚的 PluginApi（activate 用） */
  createApiWithAutoRollback: (
    instance: PluginInstance,
    config: Record<string, unknown>,
    ctx: PluginContext<Record<string, unknown>, LoopHooks>,
  ) => PluginApi;
  /** 创建无回滚的 PluginApi（deactivate 回调用，兼容旧路径） */
  createApiForPlugin: (instance: PluginInstance, config: Record<string, unknown>) => PluginApi;
  /** Skill 注册表（扫描 manifest.id- 前缀的 skill 注册 ContextSource） */
  skillRegistry: {
    getAll(): Array<{ name: string; description?: string }>;
    getFullDefinitions(names: string[]): string;
  };
  /** 上下文组合器（注册 plugin-skill-<name> ContextSource） */
  contextComposer: {
    registerSource(source: ContextSource): void;
    unregisterSource?(name: string): void;
  };
}

/**
 * 将旧 PluginDefinition 包装为 HyPlugin。
 *
 * 核心变化：PluginApi 的 register/unregister 操作不再手动追踪，
 * 而是通过 PluginContext.add() 登记到 DisposableStore，
 * 卸载时自动逆序回滚。
 */
export function wrapAsHyPlugin(
  deps: PluginAdapterDeps,
  instance: PluginInstance,
  config: Record<string, unknown>,
): HyPlugin<Record<string, unknown>, LoopHooks> {
  const { definition, manifest } = instance;

  return {
    id: manifest.id,
    // 目录插件声明依赖（plugin.json 的 deps 段）：透传给内核 HyPlugin，
    // PluginHost.mount 时做依赖校验（缺依赖直接报错，而非运行时 undefined）
    deps: manifest.deps,

    async activate(ctx) {
      const api = deps.createApiWithAutoRollback(instance, config, ctx);
      await definition.register(api);
      await definition.onActivate?.(api);

      // 注册 Skill ContextSource（通过 ctx.add 追踪，卸载自动回滚）
      const pluginSkills = deps.skillRegistry
        .getAll()
        .filter((s) => s.name.startsWith(manifest.id + '-'));

      for (const skill of pluginSkills) {
        const sourceName = `plugin-skill-${skill.name}`;
        deps.contextComposer.registerSource({
          name: sourceName,
          strategy: 'lazy_expand',
          cacheability: 'manifest',
          description: skill.description,
          getContent: () => deps.skillRegistry.getFullDefinitions([skill.name]),
        });
        ctx.add({
          dispose() {
            deps.contextComposer.unregisterSource?.(sourceName);
          },
        });
      }
    },

    async deactivate() {
      await definition.onDeactivate?.(
        deps.createApiForPlugin(instance, config),
      );
    },
  };
}
