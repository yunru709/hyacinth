/**
 * plugin-contributions.ts —— 内核插件装配贡献批（P6-1 装配贡献原语 · 本文件外移）。
 *
 * 行数收尾（P6 之后）第一步样板：把 factory 内联的插件贡献批整体外移，
 * factory 只留一次调用 + 结果解构 —— 装配逻辑不再住在装配中心里。
 *
 * knowledge/xref/generation 三个 host.mount 挂载点迁入贡献声明：先后关系由
 * needs/provides 声明 + 拓扑校验承载（缺依赖/环在解析期 fail-fast，而非注释）；
 * 生命周期仍走 PluginHost.mount（卸载回滚零损失）。TTS 句柄写回
 * loop.companionVoice（类 3 共享引用）在此批内完成。
 */

import { AssemblyRunner } from './assembly-runner.js';
import { createKnowledgePlugin } from '../plugins/knowledge-plugin.js';
import type { KnowledgeApi } from '../plugins/knowledge-plugin.js';
import { createGenerationPlugin, GENERATION_API_KEY } from '../plugins/generation-plugin.js';
import type { GenerationApi } from '../plugins/generation-plugin.js';
import { createXrefPlugin } from '../plugins/xref-plugin.js';
import type { PluginManager } from '../plugins/index.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { AgentLoop } from '../orchestrator/loop.js';
import type { AssemblyResults } from './assembly-runner.js';

export interface PluginContributionDeps {
  cwd: string;
  configCenter: RuntimeConfigCenter;
  contextComposer: LayeredContextComposer;
  pluginManager: PluginManager;
  loop: AgentLoop;
  logger: { error(msg: string, err?: Error): void };
}

/**
 * 执行内核插件贡献批（knowledge/xref/generation）。
 * 返回贡献产出（kbApi 等），factory 经 get('kbApi') 取用。
 */
export async function runPluginContributions(
  deps: PluginContributionDeps,
): Promise<AssemblyResults> {
  const contribRunner = new AssemblyRunner();
  contribRunner.provide('cwd', deps.cwd);
  contribRunner.provide('configCenter', deps.configCenter);
  contribRunner.provide('contextComposer', deps.contextComposer);
  contribRunner.provide('pluginManager', deps.pluginManager);
  contribRunner.provide('loop', deps.loop);
  return contribRunner.run([
    {
      id: 'knowledgePlugin',
      needs: ['pluginManager', 'configCenter', 'contextComposer'],
      provides: ['kbApi'],
      mount: async ({ pluginManager, configCenter, contextComposer }) => {
        const pm = pluginManager as PluginManager;
        const cfg = configCenter as RuntimeConfigCenter;
        try {
          await pm.getHost().mount(createKnowledgePlugin({
            configCenter: cfg,
            contextComposer: contextComposer as LayeredContextComposer,
          }), {
            enabled: cfg.get<boolean>('kb.enabled'),
            zone4: cfg.get<boolean>('kb.zone4'),
          });
          return { kbApi: (pm.getHost().get('knowledge.api') ?? null) as KnowledgeApi | null };
        } catch (err) {
          deps.logger.error('knowledge plugin mount failed', err instanceof Error ? err : new Error(String(err)));
          return { kbApi: null };
        }
      },
    },
    {
      id: 'xrefPlugin',
      needs: ['pluginManager', 'cwd'],
      mount: async ({ pluginManager, cwd }) => {
        // createXrefPlugin 内部 new XrefManager + init(cwd) + 注册 3 工具；失败降级 idle
        try {
          await (pluginManager as PluginManager).getHost().mount(createXrefPlugin({ cwd: cwd as string }));
        } catch (err) {
          deps.logger.error('xref plugin mount failed', err instanceof Error ? err : new Error(String(err)));
        }
      },
    },
    {
      id: 'generationPlugin',
      needs: ['pluginManager', 'cwd', 'configCenter', 'loop'],
      mount: async ({ pluginManager, cwd, configCenter, loop }) => {
        // GenerationRegistry/Service/CompanionVoiceService 装配在插件 activate 内（P3）；
        // 仅 TTS 启用时插件才装配（其余 idle）。回填 loop.companionVoice 供陪伴模式使用。
        const pm = pluginManager as PluginManager;
        try {
          await pm.getHost().mount(createGenerationPlugin({
            cwd: cwd as string,
            configCenter: configCenter as RuntimeConfigCenter,
          }));
          const genApi = (pm.getHost().get(GENERATION_API_KEY) ?? null) as GenerationApi | null;
          if (genApi?.tts) (loop as AgentLoop).companionVoice = genApi.tts;
        } catch (err) {
          deps.logger.error('generation plugin mount failed', err instanceof Error ? err : new Error(String(err)));
        }
      },
    },
  ]);
}
