/**
 * tool-service 测试 —— 闭包触手正规化（方案 C）工具执行服务薄壳。
 *
 * 覆盖：
 * - 三个方法（executeTools / executeSingleInline / flushInline）委托转发到 loop-tools
 * - makeCtx 惰性构造：每次调用现取（与旧闭包逐位等价）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createToolService, type ToolService } from './tool-service.js';
import { runToolDispatch, runToolInline, flushInlineResults } from './loop-tools.js';
import type { ToolExecContext } from './loop-tools.js';

// 纯运行时 mock：只验证转发契约，不触碰真实工具执行链路
vi.mock('./loop-tools.js', () => ({
  runToolDispatch: vi.fn().mockResolvedValue(undefined),
  runToolInline: vi.fn().mockResolvedValue(undefined),
  flushInlineResults: vi.fn().mockResolvedValue(undefined),
}));

const dispatchMock = vi.mocked(runToolDispatch);
const inlineMock = vi.mocked(runToolInline);
const flushMock = vi.mocked(flushInlineResults);

function makeService(makeCtx: () => ToolExecContext = () => ({} as ToolExecContext)): {
  svc: ToolService;
  makeCtx: ReturnType<typeof vi.fn>;
} {
  const ctxFn = vi.fn(makeCtx);
  const svc = createToolService(ctxFn);
  return { svc, makeCtx: ctxFn };
}

describe('tool-service 委托转发', () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    inlineMock.mockClear();
    flushMock.mockClear();
  });

  it('executeTools → runToolDispatch(ctx, calls)', async () => {
    const { svc } = makeService();
    const calls = [{ id: 't1', name: 'read', input: { path: 'x' } }];
    await svc.executeTools(calls);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][1]).toBe(calls);
  });

  it('executeSingleInline → runToolInline(ctx, id, name, input)', async () => {
    const { svc } = makeService();
    const input = { query: 'q' };
    await svc.executeSingleInline('c1', 'search', input);
    expect(inlineMock).toHaveBeenCalledTimes(1);
    expect(inlineMock.mock.calls[0].slice(1)).toEqual(['c1', 'search', input]);
  });

  it('flushInline → flushInlineResults(ctx, calls)', async () => {
    const { svc } = makeService();
    const calls = [{ id: 't1', name: 'read', input: {} }];
    await svc.flushInline(calls);
    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(flushMock.mock.calls[0][1]).toBe(calls);
  });

  it('makeCtx 惰性构造：每次方法调用现取（getter 而非快照）', async () => {
    const makeCtx = vi.fn(() => ({} as ToolExecContext));
    const { svc } = makeService(makeCtx);

    await svc.executeTools([]);
    await svc.executeSingleInline('c1', 'read', {});
    await svc.flushInline([]);
    await svc.executeTools([]);

    expect(makeCtx).toHaveBeenCalledTimes(4);
  });
});
