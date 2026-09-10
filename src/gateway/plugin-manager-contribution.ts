/**
 * plugin-contributions.ts —— 插件管理器贡献（行数收尾第十批扩展）。
 *
 * PluginManager 创建迁入贡献（needs toolRegistry/skillRegistry/contextComposer/
 * mcpSystem/cwd）。loadAll 与 setHooks 仍留 factory（依赖 loop.loopHooks，时序
 * 在 AgentLoop 构造后）。
 */

import { AssemblyRunner } from './assembly-runner.js';
import { PluginManager } from '../plugins/index.js';
import type { ExtensionRegistry } from '../supervisor/extension-registry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { MCPSystem } from '../mcp/system.js';

export interface PluginManagerContributionDeps {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  contextComposer: LayeredContextComposer;
  mcpSystem: MCPSystem;
  cwd: string;
  /** 架构监督（扩展注册表方案）：loadAll 装载前的名单裁决（可选，未装配走原三源语义） */
  extensionRegistry?: ExtensionRegistry;
}

/** 执行插件管理器贡献，返回 pluginManager（loadAll/setHooks 由 factory 在 loop 后调用） */
export async function runPluginManagerContribution(
  deps: PluginManagerContributionDeps,
): Promise<{ pluginManager: PluginManager }> {
  const runner = new AssemblyRunner();
  for (const [k, v] of Object.entries(deps)) runner.provide(k, v);
  const results = await runner.run([
    {
      id: 'pluginManager',
      needs: ['toolRegistry', 'skillRegistry', 'contextComposer', 'mcpSystem', 'cwd'],
      provides: ['pluginManager'],
      mount: async (d) => {
        const pluginManager = new PluginManager({
          toolRegistry: d.toolRegistry as ToolRegistry,
          skillRegistry: d.skillRegistry as SkillRegistry,
          contextComposer: d.contextComposer as LayeredContextComposer,
          projectDir: d.cwd as string,
          mcpSystem: d.mcpSystem as MCPSystem,
          extensionRegistry: d.extensionRegistry as ExtensionRegistry | undefined,
        });
        // 架构贡献申报（P-B 就绪即上报，先于 agent/service/slot/source 分发表应用）：
        // 只读 manifest 的 architecture 段，不执行插件代码 —— 使插件声明能在
        // 装配期（loop 前/后各分发表）被裁决生效。
        await pluginManager.reportArchitecture();
        return { pluginManager };
      },
    },
  ]);
  return { pluginManager: results.get('pluginManager') as PluginManager };
}
