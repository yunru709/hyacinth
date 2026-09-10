/**
 * P1 M3 · 管道装配验收：defaults 骨架（kernel.pipeline）与真实阶段模块装配，
 * 契约校验零 issue，describe() 输出槽位绑定符合预期（M3 验收标准）。
 */
import { describe, it, expect } from 'vitest';
import { Pipeline, createPipelineBus } from '../../kernel/pipeline.js';
import { createInputStage, INPUT_STAGE_ID } from './input.js';
import { createFinalizeStage, FINALIZE_STAGE_ID } from './finalize.js';
import { createContextStage, CONTEXT_STAGE_ID } from './context.js';
import { createLlmStage, LLM_STAGE_ID } from './llm.js';
import { createToolsStage, TOOLS_STAGE_ID } from './tools.js';
import { createBypassStage, BYPASS_STAGE_ID } from './bypass.js';
import { getDefaultConfig } from '../../runtime/defaults.js';
import type { TurnState } from '../turn-state.js';
import type { SlotSpec } from '../../kernel/pipeline.js';

describe('M3 管道装配（defaults 骨架）', () => {
  it('装配零契约问题；六槽位全部启用绑定正确', () => {
    const slots = getDefaultConfig().kernel?.pipeline as SlotSpec[] | undefined;
    const pipeline = new Pipeline<TurnState>({
      modules: [createInputStage(), createBypassStage(), createContextStage(), createLlmStage(), createToolsStage(), createFinalizeStage()],
      spec: { slots: slots ?? [] },
      hooks: createPipelineBus(),
    });

    const result = pipeline.assemble();

    expect(result.issues).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.stages.map((s) => s.slot)).toEqual(['input', 'bypass', 'context', 'llm', 'tools', 'finalize']);

    const desc = pipeline.describe();
    expect(desc.find((d) => d.slot === 'input')).toMatchObject({ impl: INPUT_STAGE_ID, enabled: true });
    expect(desc.find((d) => d.slot === 'bypass')).toMatchObject({ impl: BYPASS_STAGE_ID, enabled: true });
    expect(desc.find((d) => d.slot === 'context')).toMatchObject({ impl: CONTEXT_STAGE_ID, enabled: true });
    expect(desc.find((d) => d.slot === 'llm')).toMatchObject({ impl: LLM_STAGE_ID, enabled: true });
    expect(desc.find((d) => d.slot === 'tools')).toMatchObject({ impl: TOOLS_STAGE_ID, enabled: true });
    expect(desc.find((d) => d.slot === 'finalize')).toMatchObject({ impl: FINALIZE_STAGE_ID, enabled: true });
  });

  it('strict 模式：槽位 requires 超出模块声明时装配抛错（防换模块时装错）', () => {
    const badSlots: SlotSpec[] = [
      { id: 'input', impl: INPUT_STAGE_ID, enabled: true, requires: { writes: ['nonexistent_field'] } },
    ];
    const pipeline = new Pipeline<TurnState>({
      modules: [createInputStage()],
      spec: { slots: badSlots },
      hooks: createPipelineBus(),
    });

    expect(() => pipeline.assemble()).toThrow(/missing-writes/);
  });
});
