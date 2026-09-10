/**
 * stage-registry.ts —— 内置阶段贡献注册表（P6-3 交付物）。
 *
 * P6-3 判据②「内置与插件走同一条路」：
 * create-kernel.ts 不再硬编码 6 个 create*Stage() 数组，而是遍历本注册表、
 * 经 Pipeline.registerStageModule 逐条注册 —— 与插件注册/替换内置阶段是同一 API。
 *
 * 单一真源：新增内置阶段 = 本表加一项，create-kernel.ts 零改动；
 * 阶段 id 与 DEFAULT_PIPELINE_SLOTS 的 impl 一致性由守卫测试锁死（防漂移）。
 */

import { createInputStage, INPUT_STAGE_ID } from './stages/input.js';
import { createBypassStage, BYPASS_STAGE_ID } from './stages/bypass.js';
import { createContextStage, CONTEXT_STAGE_ID } from './stages/context.js';
import { createLlmStage, LLM_STAGE_ID } from './stages/llm.js';
import { createToolsStage, TOOLS_STAGE_ID } from './stages/tools.js';
import { createFinalizeStage, FINALIZE_STAGE_ID } from './stages/finalize.js';
import type { StageModule } from '../kernel/pipeline.js';
import type { TurnState } from './turn-state.js';
import type { StageServiceMap } from './stage-services.js';

/** 一条内置阶段贡献：id = 模块 id（slot.impl 引用），create = 阶段工厂 */
export interface StageContribution {
  id: string;
  create: () => StageModule<TurnState, StageServiceMap>;
}

/** 内置阶段贡献清单（顺序无意义 —— 槽位顺序由 kernel.pipeline 配置决定） */
export const BUILTIN_STAGE_CONTRIBUTIONS: StageContribution[] = [
  { id: INPUT_STAGE_ID, create: createInputStage },
  { id: BYPASS_STAGE_ID, create: createBypassStage },
  { id: CONTEXT_STAGE_ID, create: createContextStage },
  { id: LLM_STAGE_ID, create: createLlmStage },
  { id: TOOLS_STAGE_ID, create: createToolsStage },
  { id: FINALIZE_STAGE_ID, create: createFinalizeStage },
];

/** 内置阶段 id 列表（守卫：与 DEFAULT_PIPELINE_SLOTS 的 impl 集一致） */
export const BUILTIN_STAGE_IDS: string[] = BUILTIN_STAGE_CONTRIBUTIONS.map((c) => c.id);
