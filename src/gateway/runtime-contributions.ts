/**
 * runtime-contributions.ts —— 运行时装配贡献批（行数收尾第二批 · 外移样板）。
 *
 * 与 plugin-contributions.ts 同模式：把 factory 尾部的直接 new 业务类
 * （ToolBundleRegistry / HotReloadManager）迁入贡献声明，factory 只留一次调用
 * + 结果解构。二者均为「依赖已就绪、无前向引用、产出单一」的类 —— 是
 * AssemblyRunner 增量多批的第一个消费者（独立贡献批，非插件挂载面）。
 *
 * 迁移代价：每迁出一个类，assembly-whitelist.mjs 白名单删一条（只减不增）。
 */

import { AssemblyRunner } from './assembly-runner.js';
import type { AssemblyResults } from './assembly-runner.js';
import { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { HotReloadManager } from '../hot-reload/index.js';
import type { ExtensionRegistry } from '../supervisor/extension-registry.js';
import type { ManifestAccessLike } from '../hot-reload/extension-registry-watcher.js';
import type { ToolLinksAccessLike } from '../hot-reload/tool-links-watcher.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { AgentRegistry } from '../agents/index.js';
import type { PluginManager } from '../plugins/index.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { MCPSystem } from '../mcp/system.js';
import type { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import type { ProviderConfigLoader } from '../provider/config.js';
import { modelCatalog } from '../provider/catalog.js';

export interface RuntimeContributionDeps {
  cwd: string;
  configCenter: RuntimeConfigCenter;
  contextComposer: LayeredContextComposer;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
  pluginManager: PluginManager;
  mcpSystem: MCPSystem;
  channelRegistry: ModelChannelRegistry;
  providerConfigLoader: ProviderConfigLoader;
  modelCatalog: typeof modelCatalog;
  /** 架构监督（扩展注册表方案）：名单 watcher 数据源（可选，未装配则 watcher 跳过注册） */
  extensionRegistry?: ExtensionRegistry;
  /** 名单访问面（与 extensionRegistry 成对注入） */
  manifestAccess?: ManifestAccessLike;
  /** 联动清单访问面（未注入 ⇒ 该 watcher 不注册，与 manifestAccess 同款） */
  toolLinksAccess?: ToolLinksAccessLike;
}

/** 执行运行时贡献批（ToolBundleRegistry / HotReloadManager），返回产出（bundleRegistry / hotReloadManager） */
export async function runRuntimeContributions(
  deps: RuntimeContributionDeps,
): Promise<AssemblyResults> {
  const runner = new AssemblyRunner();
  for (const [k, v] of Object.entries(deps)) runner.provide(k, v);
  return runner.run([
    {
      id: 'bundleRegistry',
      needs: ['cwd'],
      provides: ['bundleRegistry'],
      mount: ({ cwd }) => ({ bundleRegistry: new ToolBundleRegistry(cwd as string) }),
    },
    {
      id: 'hotReloadManager',
      needs: [
        'toolRegistry', 'skillRegistry', 'agentRegistry', 'pluginManager',
        'configCenter', 'contextComposer', 'mcpSystem', 'bundleRegistry',
        'channelRegistry', 'cwd', 'providerConfigLoader', 'modelCatalog', 'extensionRegistry', 'manifestAccess', 'toolLinksAccess',
      ],
      provides: ['hotReloadManager'],
      mount: (d) => ({
        hotReloadManager: new HotReloadManager({
          toolRegistry: d.toolRegistry as ToolRegistry,
          skillRegistry: d.skillRegistry as SkillRegistry,
          agentRegistry: d.agentRegistry as AgentRegistry,
          pluginManager: d.pluginManager as PluginManager,
          configCenter: d.configCenter as RuntimeConfigCenter,
          contextComposer: d.contextComposer as LayeredContextComposer,
          mcpSystem: d.mcpSystem as MCPSystem,
          bundleRegistry: d.bundleRegistry as ToolBundleRegistry,
          channelRegistry: d.channelRegistry as ModelChannelRegistry,
          cwd: d.cwd as string,
          providerConfigLoader: d.providerConfigLoader as ProviderConfigLoader,
          modelCatalog: d.modelCatalog as typeof modelCatalog,
          extensionRegistry: d.extensionRegistry as ExtensionRegistry | undefined,
          manifestAccess: d.manifestAccess as ManifestAccessLike | undefined,
          toolLinksAccess: d.toolLinksAccess as ToolLinksAccessLike | undefined,
        }),
      }),
    },
  ]);
}
