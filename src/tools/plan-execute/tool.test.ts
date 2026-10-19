/**
 * plan_execute 内层工具准入测试。
 *
 * 背景：plan_execute 的内层执行走裸 ToolExecutor，不经过 loop-tools 的
 * ToolExecContext。若不给它一个 allow 谓词，goal 模式下可用它调
 * say / switch_mode / new_session / update_config 等被禁工具。
 */
import { describe, it, expect, vi } from 'vitest';
import { createPlanExecuteTool } from './tool.js';
import type { ToolExecutor } from '../executor.js';

function fakeExecutor() {
  return { execute: vi.fn() } as unknown as ToolExecutor & { execute: ReturnType<typeof vi.fn> };
}

describe('plan_execute 内层工具准入（allow 谓词）', () => {
  it('被 allow 拒绝的工具不执行，返回结构化失败', async () => {
    const executor = fakeExecutor();
    const tool = createPlanExecuteTool(executor, {
      allow: (name) => name !== 'say',
    });

    const out = await tool.execute({
      steps: [
        {
          commands: [{ tool: 'say', input: { content: '逃逸' } }],
          prediction: { success: true },
        },
      ],
    });
    const json = JSON.parse(out) as {
      ok: boolean;
      status: string;
      failedCommands: string[];
      actual: Array<{ content: string; is_error: boolean }>;
    };

    expect(executor.execute).not.toHaveBeenCalled();
    expect(json.ok).toBe(false);
    expect(json.status).toBe('handoff');
    expect(json.failedCommands).toContain('say');
    expect(json.actual[0].is_error).toBe(true);
    expect(json.actual[0].content).toContain('not allowed');
  });

  it('allow 放行时正常交给 executor', async () => {
    const executor = fakeExecutor();
    executor.execute.mockResolvedValue({ tool_use_id: 'x', content: 'ok', is_error: false });
    const tool = createPlanExecuteTool(executor, {
      allow: () => true,
    });

    const out = await tool.execute({
      steps: [
        {
          commands: [{ tool: 'read', input: { file_path: 'x' } }],
          prediction: { success: true },
        },
      ],
    });
    const json = JSON.parse(out) as { ok: boolean };

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(json.ok).toBe(true);
  });
});
