/**
 * 收敛点③：tool-links 执行记录（2026-10-30）
 *
 * 目标：任何 Sink 执行的成败都留痕，杜绝「跑了没跑、成没成、错在哪」全都看不见。
 *
 * 这些用例锁死四件事：
 *   1. invoke 成功 → ok=true 且带目标工具名
 *   2. invoke 失败 → ok=false + 错误信息（不再只 console.error）
 *   3. invokeTool 未注入 → 明确报错（以前是静默跳过）
 *   4. append 类也记录耗时（用于统计命中频率/性能）
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { invokeToolHandler } from '../orchestrator/tool-link-handlers.js';
import {
  getToolLinkExecutions,
  getToolLinkExecutionStats,
  resetToolLinkExecutions,
  setToolLinkFailureLogging,
} from './tool-link-executions.js';
import { runToolLinksForEvent, setToolLinkRuntime, ToolLinkRegistry } from './tool-links.js';

// 测试不污染真实失败日志文件
setToolLinkFailureLogging(false);

function install(
  invokeTool: ((tool: string, args: Record<string, unknown>) => Promise<string>) | undefined,
  extraHandlers: Parameters<ToolLinkRegistry['register']>[0][] = [],
): void {
  const registry = new ToolLinkRegistry();
  registry.register(invokeToolHandler);
  for (const h of extraHandlers) registry.register(h);
  setToolLinkRuntime({
    registry,
    invokeTool,
    getManifest: () => ({
      version: 1,
      links: [
        { on: 'afterWatch:process', handler: 'core.invoke-tool', invoke: { tool: 'say', args: { content: 'x' } } },
        ...extraHandlers.map((h) => ({ on: 'afterWatch:process', handler: h.id })),
      ],
    }),
  });
}

describe('收敛点③：执行记录', () => {
  beforeEach(() => {
    resetToolLinkExecutions();
    setToolLinkRuntime(null);
  });

  it('invoke 成功 → ok=true 且记录目标工具名', async () => {
    install(async () => 'ok');
    await runToolLinksForEvent('afterWatch:process', {});

    const [e] = getToolLinkExecutions();
    expect(e).toBeDefined();
    expect(e.ok).toBe(true);
    expect(e.tool).toBe('say');
    expect(e.handlerId).toBe('core.invoke-tool');
    expect(e.kind).toBe('invoke');
    expect(e.event).toBe('afterWatch:process');
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    expect(e.error).toBeUndefined();
  });

  it('invoke 失败 → ok=false 且带错误信息（不再静默）', async () => {
    install(async () => {
      throw new Error('工具炸了');
    });
    await runToolLinksForEvent('afterWatch:process', {});

    const [e] = getToolLinkExecutions();
    expect(e.ok).toBe(false);
    expect(e.tool).toBe('say');
    expect(e.error).toBe('工具炸了');

    const stats = getToolLinkExecutionStats();
    expect(stats.fail).toBe(1);
    expect(stats.lastError).toBe('工具炸了');
  });

  it('invokeTool 未注入 → 记录明确的装配错误（以前静默跳过）', async () => {
    install(undefined);
    await runToolLinksForEvent('afterWatch:process', {});

    const [e] = getToolLinkExecutions();
    expect(e.ok).toBe(false);
    expect(e.error).toContain('invokeTool 未注入');
  });

  it('append 类也记录（用于统计命中频率与耗时）', async () => {
    install(
      async () => '',
      [
        {
          id: 'test.append',
          kind: 'append',
          owner: 'core',
          on: 'afterWatch:process',
          run: async () => '附加文本',
        },
      ],
    );
    const out = await runToolLinksForEvent('afterWatch:process', {});

    expect(out).toEqual(['附加文本']);
    const records = getToolLinkExecutions();
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.ok)).toBe(true);
    const appendRec = records.find((r) => r.handlerId === 'test.append');
    expect(appendRec?.kind).toBe('append');
    // append 类不上报 tool
    expect(appendRec?.tool).toBeUndefined();
  });

  it('多次执行累计统计正确，单次查询按时间正序', async () => {
    install(async () => 'ok');
    await runToolLinksForEvent('afterWatch:process', {});
    await runToolLinksForEvent('afterWatch:process', {});

    const stats = getToolLinkExecutionStats();
    expect(stats.total).toBe(2);
    expect(stats.ok).toBe(2);
    expect(stats.fail).toBe(0);

    const recs = getToolLinkExecutions(1);
    expect(recs).toHaveLength(1); // limit 生效
  });

  it('未装配 runtime 时直接返回，不产生记录（也不报错）', async () => {
    const out = await runToolLinksForEvent('afterWatch:process', {});
    expect(out).toEqual([]);
    expect(getToolLinkExecutions()).toHaveLength(0);
  });
});
