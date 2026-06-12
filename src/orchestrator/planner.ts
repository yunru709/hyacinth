import type { Provider } from '../provider/interface.js';
import type { Plan } from './plan-store.js';
import type { ModelRouter } from '../provider/model-router.js';
import { PlanStore } from './plan-store.js';

/**
 * LLMOrchestrator — 编排器骨架。
 *
 * 注意: assess/plan LLM 编排功能已在 v2026-06-07 移除（由工具包系统取代）。
 * 此类保留作为 Provider 切换和计划进度追踪的挂载点。
 */
export class LLMOrchestrator {
  private modelRouter?: ModelRouter;

  constructor(
    private provider: Provider,
    private planStore: PlanStore,
    private sessionDir: string,
    modelRouter?: ModelRouter,
  ) {
    this.modelRouter = modelRouter;
  }

  setProvider(provider: Provider): void {
    this.provider = provider;
    this.modelRouter?.setMainProvider(provider);
  }

  updatePlanProgress(plan: Plan, toolName: string): Plan {
    for (const step of plan.steps) {
      if (step.status !== 'pending' && step.status !== 'in_progress') continue;
      if (step.selectedTools.includes(toolName)) {
        (step as { status: string }).status = 'completed';
        break;
      }
    }
    return plan;
  }
}
