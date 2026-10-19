import { describe, it, expect, vi } from 'vitest';
import { RestartTool } from './restart.js';

describe('restart 工具：构建冒烟门', () => {
  it('冒烟失败 → 抛错且不安排重启（exit 不被调用）', async () => {
    const exit = vi.fn();
    const tool = new RestartTool(process.cwd(), 'sess', 'tui', {
      smokeTest: async () => ({ ok: false, detail: 'dist is broken' }),
      exit,
      exitDelayMs: 0,
    });

    await expect(tool.execute({})).rejects.toThrow(/blocked.*dist is broken/);
    expect(exit).not.toHaveBeenCalled();
  });
});
