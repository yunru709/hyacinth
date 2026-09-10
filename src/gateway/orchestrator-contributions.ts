/**
 * orchestrator-contributions.ts —— 编排贡献批（行数收尾第七批）。
 *
 * 迁移编排组 4 类：PlanStore → LLMOrchestrator（needs planStore + provider +
 * sessionDir + modelRouter）、AgentRegistry、ToolExecutor（needs toolRegistry）、
 * BackgroundProcessRegistry。
 *
 * ProviderRouter 因 register('main'/'local') 接线简单但与 provider 对象强耦合，
 * 一并迁入（needs provider + localModelProvider）。
 *
 * loadAgentConfigs + agentRegistry.register 循环、DelegateToAgentTool（依赖
 * subProvider* 闭包配置）属接线，留 factory。
 */

import { AssemblyRunner } from './assembly-runner.js';
import type { AssemblyResults } from './assembly-runner.js';
import { PlanStore } from '../orchestrator/plan-store.js';
import { LLMOrchestrator } from '../orchestrator/planner.js';
import { ProviderRouter } from '../provider/router.js';
import { AgentRegistry } from '../agents/index.js';
import { ToolExecutor } from '../tools/executor.js';
import { BackgroundProcessRegistry } from '../tools/background-registry.js';
import type { Provider } from '../provider/interface.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface OrchestratorContributionDeps {
  provider: Provider;
  localModelProvider: Provider | undefined;
  sessionDir: string;
  modelRouter: ModelRouter;
  toolRegistry: ToolRegistry;
}

/** 执行编排贡献批（planStore/orchestrator/providerRouter/agentRegistry/toolExecutor/backgroundRegistry） */
export async function runOrchestratorContributions(
  deps: OrchestratorContributionDeps,
): Promise<AssemblyResults> {
  const runner = new AssemblyRunner();
  for (const [k, v] of Object.entries(deps)) runner.provide(k, v);
  return runner.run([
    {
      id: 'planStore',
      needs: [],
      provides: ['planStore'],
      mount: () => ({ planStore: new PlanStore() }),
    },
    {
      id: 'orchestrator',
      needs: ['provider', 'planStore', 'sessionDir', 'modelRouter'],
      provides: ['orchestrator'],
      mount: (d) => ({
        orchestrator: new LLMOrchestrator(
          d.provider as Provider,
          d.planStore as PlanStore,
          d.sessionDir as string,
          d.modelRouter as ModelRouter,
        ),
      }),
    },
    {
      id: 'providerRouter',
      needs: ['provider', 'localModelProvider'],
      provides: ['providerRouter'],
      mount: (d) => {
        const providerRouter = new ProviderRouter();
        providerRouter.register('main', d.provider as Provider);
        if (d.localModelProvider) {
          providerRouter.register('local', d.localModelProvider as Provider);
        }
        return { providerRouter };
      },
    },
    {
      id: 'agentRegistry',
      needs: [],
      provides: ['agentRegistry'],
      mount: () => ({ agentRegistry: new AgentRegistry() }),
    },
    {
      id: 'toolExecutor',
      needs: ['toolRegistry'],
      provides: ['toolExecutor'],
      mount: ({ toolRegistry }) => ({
        toolExecutor: new ToolExecutor(toolRegistry as ToolRegistry),
      }),
    },
    {
      id: 'backgroundRegistry',
      needs: [],
      provides: ['backgroundRegistry'],
      mount: () => ({ backgroundRegistry: new BackgroundProcessRegistry() }),
    },
  ]);
}
