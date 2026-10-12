/**
 * goal 模式工具单测（src/tools/runtime-control/goal.ts）——
 * 工具只是 loop 注入回调的薄壳：这里用假回调验证「成功返回内容 / 失败抛错（is_error 语义）」。
 */

import { describe, it, expect } from 'vitest';
import { createEnterGoalTool, createFinishGoalTool } from './goal.js';

describe('enter_goal', () => {
  it('成功 → 返回 loop 给的说明（note）', async () => {
    const tool = createEnterGoalTool(() => ({ ok: true, note: '已进入 goal 模式' }));
    expect(await tool.execute({ objective: '把 X 做完' })).toBe('已进入 goal 模式');
  });

  it('失败 → 抛错（框架落 is_error）', async () => {
    const tool = createEnterGoalTool(() => ({ ok: false, error: '已在 goal 模式下' }));
    await expect(tool.execute({ objective: 'X' })).rejects.toThrow('已在 goal 模式下');
  });

  it('把 objective 原样传给 loop，并以 agent 身份进入', () => {
    let got: { obj: string; by: string } | null = null;
    const tool = createEnterGoalTool((objective, by) => {
      got = { obj: objective, by };
      return { ok: true, note: 'ok' };
    });
    void tool.execute({ objective: '目标原文' });
    expect(got).toEqual({ obj: '目标原文', by: 'agent' });
  });

  it('schema 必填 objective', () => {
    const tool = createEnterGoalTool(() => ({ ok: true, note: 'ok' }));
    expect(tool.inputSchema.required).toContain('objective');
    expect(tool.name).toBe('enter_goal');
  });
});

describe('finish_goal', () => {
  it('审查通过 → 返回 ok', async () => {
    const tool = createFinishGoalTool(async () => ({ ok: true }));
    expect(await tool.execute({ evidence: '测试通过', conclusion: '目标达成' })).toBe('ok');
  });

  it('审查不通过 → 抛错且带上审查理由', async () => {
    const tool = createFinishGoalTool(async () => ({ ok: false, error: '证据与结论无关' }));
    await expect(tool.execute({ evidence: 'x', conclusion: 'y' })).rejects.toThrow('证据与结论无关');
  });

  it('把 evidence / conclusion 原样传给 loop', async () => {
    let got: { e: string; c: string } | null = null;
    const tool = createFinishGoalTool(async (evidence, conclusion) => {
      got = { e: evidence, c: conclusion };
      return { ok: true };
    });
    await tool.execute({ evidence: 'EV', conclusion: 'CC' });
    expect(got).toEqual({ e: 'EV', c: 'CC' });
  });

  it('schema 必填 evidence / conclusion', () => {
    const tool = createFinishGoalTool(async () => ({ ok: true }));
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['evidence', 'conclusion']));
    expect(tool.name).toBe('finish_goal');
  });
});
