/**
 * loop-integration.test.ts —— AgentLoop 级集成测试（P0 回归锁定）。
 *
 * 独立审查报告指出的核心 bug：runTurn 每轮调 `pipeline.run()` 7 次，
 * 而 `run()` 每次全槽遍历 → llm 阶段每轮重复执行 7 次（createStream 7 次），
 * 且首次调用发生在 activeProvider 路由赋值前 → context 阶段崩。
 * 修复：Pipeline 新增 `runSlot(slotId)`，runTurn 按阶段逐槽调用。
 *
 * 本测试构造**真实 AgentLoop + 真实 6 槽 pipeline**（createKernel 内置阶段
 * 模块），仅 mock 外部服务。核心断言：一轮 turn 内 `provider.createStream`
 * **恰好 1 次**、首轮不崩、finalize 正常结束（stop=true）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './loop.js';
import type { AgentLoopServices } from './loop.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { Provider } from '../provider/interface.js';

const tmpDirs: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-int-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** 模拟 provider：createStream 返回一段文本流，spy 计数 */
function makeProvider() {
  const createStream = vi.fn().mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', content: '你好' };
      yield { type: 'stop', reason: 'end_turn' };
    },
  }));
  const provider = {
    getProviderType: () => 'deepseek',
    getModel: () => 'deepseek-chat',
    getCapabilities: () => ({ vision: false }),
    setThinking: vi.fn(),
    createStream,
  } as unknown as Provider;
  return { provider, createStream };
}

/** 构造 AgentLoopServices：各阶段模块 require/get 的服务全量提供（参考 stages/context.test.ts mock 面） */
function makeServices(provider: Provider): AgentLoopServices {
  const conversationStore = {
    readAll: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
  };
  const eventStore = { append: vi.fn().mockResolvedValue(undefined) };
  const statsManager = {
    get: vi.fn().mockResolvedValue({ input_tokens: 0, output_tokens: 0, cache_turns: [] }),
    update: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn().mockResolvedValue(undefined),
  };
  const summaryStore = {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const toolRegistry = {
    register: vi.fn(),
    getToolDefinitions: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
  };
  const contextComposer = {
    compose: vi.fn().mockResolvedValue({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      zoneBreakdown: { total: 100 },
    }),
    activeConditions: new Set<string>(),
  };
  return {
    provider,
    contextComposer,
    compressor: { compress: vi.fn().mockResolvedValue(null) } as never,
    orchestrator: {} as never,
    toolExecutor: {} as never,
    toolRegistry: toolRegistry as never,
    conversationStore: conversationStore as never,
    eventStore: eventStore as never,
    statsManager: statsManager as never,
    summaryStore: summaryStore as never,
    flowRegistry: { getActive: () => null } as never,
  } as unknown as AgentLoopServices;
}

describe('AgentLoop 集成：runTurn ↔ pipeline（P0 回归）', () => {
  it('一轮 turn：provider.createStream 恰好调用 1 次（修复前为 7 次）', async () => {
    const { provider, createStream } = makeProvider();
    const loop = new AgentLoop(makeServices(provider), { sessionDir: tmpdir() });

    const result = await (loop as unknown as { runTurn(): Promise<{ stop: boolean; stopReason?: string }> }).runTurn();

    expect(createStream).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe(true);
  });

  it('首轮不崩溃：activeProvider 在 input 阶段后、context 阶段前已路由赋值', async () => {
    const { provider } = makeProvider();
    const loop = new AgentLoop(makeServices(provider), { sessionDir: tmpdir() });

    await expect(
      (loop as unknown as { runTurn(): Promise<unknown> }).runTurn(),
    ).resolves.toBeDefined();
  });

  it('阶段编排：llm 唯一一次请求用的 messages 来自 context 阶段产出（compose 被消费）', async () => {
    const { provider, createStream } = makeProvider();
    const loop = new AgentLoop(makeServices(provider), { sessionDir: tmpdir() });

    await (loop as unknown as { runTurn(): Promise<unknown> }).runTurn();

    // createStream 收到的第一个参数是 messages（context compose 的产物）
    const messages = createStream.mock.calls[0]?.[0] as unknown[];
    expect(Array.isArray(messages)).toBe(true);
    expect(messages?.length).toBeGreaterThan(0);
  });

  it('连续多轮：每轮恰好 1 次 createStream（无累积翻倍）', async () => {
    const { provider, createStream } = makeProvider();
    const loop = new AgentLoop(makeServices(provider), { sessionDir: tmpdir() });
    const rt = () => (loop as unknown as { runTurn(): Promise<{ stop: boolean }> }).runTurn();

    await rt();
    await rt();
    await rt();

    expect(createStream).toHaveBeenCalledTimes(3);
  });
});

// ── maxContextTokens 兜底链回归（490ef42 修复锁定）──────────────────

describe('AgentLoop maxContextTokens 兜底链（490ef42 回归）', () => {
  /** 构造最小 configCenter mock（get 按路径返回；watch 空实现返回退订函数） */
  function makeConfigCenter(pathValues: Record<string, unknown>): RuntimeConfigCenter {
    return {
      get: vi.fn((path: string) => pathValues[path]),
      watch: vi.fn(() => () => {}),
    } as unknown as RuntimeConfigCenter;
  }

  function makeLoop(configCenter: RuntimeConfigCenter | undefined, opts: Record<string, unknown> = {}): number {
    const services = makeServices(makeProvider().provider);
    if (configCenter) services.configCenter = configCenter;
    const loop = new AgentLoop(services, { sessionDir: tmpdir(), ...opts } as never);
    return (loop as unknown as { maxContextTokens: number }).maxContextTokens;
  }

  it('config 配了 session.maxContext → 用 config（配置为权威）', () => {
    const cfg = makeConfigCenter({ 'session.maxContext': 300000 });
    // opts 也传了更小值 → config 仍优先
    expect(makeLoop(cfg, { maxContextTokens: 8000 })).toBe(300000);
  });

  it('config 未配 + opts 显式传 maxContextTokens → 用 opts（修复点 1）', () => {
    const cfg = makeConfigCenter({}); // 未配 session.maxContext
    expect(makeLoop(cfg, { maxContextTokens: 123456 })).toBe(123456);
  });

  it('config 与 opts 都缺 → DEFAULT_MAX_CONTEXT_TOKENS（修复点 2，原为 undefined）', () => {
    expect(makeLoop(undefined, {})).toBe(200000); // DEFAULT_MAX_CONTEXT_TOKENS
  });

  it('config 存在但完全未配 → 也回退 opts/DEFAULT（原实现返回 undefined 的路径）', () => {
    const cfg = makeConfigCenter({});
    expect(makeLoop(cfg, {})).toBe(200000);
    expect(makeLoop(cfg, { maxContextTokens: 777 })).toBe(777);
  });
});
