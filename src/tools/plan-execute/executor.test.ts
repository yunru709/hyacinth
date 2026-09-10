// plan-execute/executor 执行器单测（注入 fake runCommand，纯逻辑）
import { describe, it, expect, vi } from 'vitest';
import { executePlan } from './executor.js';
import type { Plan, CommandResult } from './types.js';

/** fake 命令执行器：按 tool 名返回结果 */
function makeRun(table: Record<string, CommandResult>) {
  return vi.fn(async (call: { tool: string }): Promise<CommandResult> => {
    const hit = table[call.tool];
    return hit ?? { tool: call.tool, content: '', is_error: true };
  });
}

describe('plan_execute 执行器（纯机械，零 LLM）', () => {
  it('全部步骤预测命中 → done（串行逐步推进）', async () => {
    const run = makeRun({
      a: { tool: 'a', content: 'ok1', is_error: false },
      b: { tool: 'b', content: 'ok2', is_error: false },
    });
    const plan: Plan = {
      steps: [
        { commands: [{ tool: 'a', input: {} }], prediction: { outputContains: 'ok1' } },
        { commands: [{ tool: 'b', input: {} }], prediction: { success: true } },
      ],
    };

    const result = await executePlan(plan, run);
    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].predictionVerdict.ok).toBe(true);
    }
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('预测落空 → handoff（交回主循环，附失败上下文）', async () => {
    const run = makeRun({
      a: { tool: 'a', content: 'ok', is_error: false },
      b: { tool: 'b', content: 'boom', is_error: false },
    });
    const plan: Plan = {
      steps: [
        { commands: [{ tool: 'a', input: {} }], prediction: { success: true } },
        { commands: [{ tool: 'b', input: {} }], prediction: { outputContains: 'expected' } },
      ],
    };

    const result = await executePlan(plan, run);
    expect(result.status).toBe('handoff');
    if (result.status === 'handoff') {
      expect(result.stepIndex).toBe(1);
      expect(result.completed).toHaveLength(1); // 第一步已完成
      expect(result.reason).toContain('expected');
      expect(result.actual[0].content).toBe('boom');
      expect(result.prediction).toEqual({ outputContains: 'expected' });
    }
    // 第二步落空后不再执行更多步骤
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('组内并行：parallel=true 时全部命令同时执行（Promise.all）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const run = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { tool: 'x', content: 'done', is_error: false };
    });
    const plan: Plan = {
      steps: [
        {
          commands: [{ tool: 'x', input: {} }, { tool: 'x', input: {} }, { tool: 'x', input: {} }],
          prediction: { success: true },
          parallel: true,
        },
      ],
    };
    await executePlan(plan, run);
    expect(maxInFlight).toBe(3); // 三条命令并发
  });

  it('组内串行：后命令在前命令完成后执行', async () => {
    const order: string[] = [];
    const run = vi.fn(async (call: { tool: string }) => {
      order.push(call.tool);
      await new Promise((r) => setTimeout(r, 5));
      return { tool: call.tool, content: 'done', is_error: false };
    });
    const plan: Plan = {
      steps: [
        {
          commands: [{ tool: 'a', input: {} }, { tool: 'b', input: {} }],
          prediction: { success: true },
        },
      ],
    };
    await executePlan(plan, run);
    expect(order).toEqual(['a', 'b']);
  });

  it('空计划 → done（无步骤）', async () => {
    const run = makeRun({});
    const result = await executePlan({ steps: [] }, run);
    expect(result.status).toBe('done');
  });
});
