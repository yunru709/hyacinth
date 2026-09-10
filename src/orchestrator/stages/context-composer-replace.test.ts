/**
 * 门槛 2 集成验收：生产消费方（stages/context.ts 内置模块）真实消费第二个
 * ContextComposerLike 实现（TruncatingContextComposer）—— 接口夹在两块生产/真实代码之间。
 *
 * 对照 demo-override-context（换的是 stage 模块本身），本测试换的是 stage 依赖的
 * contextComposer 服务实现：内置 stage 的 12 步逻辑原样跑，只有 composer 是激进截断版。
 */
import { describe, it, expect, vi } from 'vitest';
import { createContextStage } from './context.js';
import type { StageContext } from '../../kernel/pipeline.js';
import { createTurnState, type TurnState } from '../turn-state.js';
import { TruncatingContextComposer, estimateMessageTokens } from '../../context/truncating-composer.js';
import type { Message } from '../../types.js';

/** context 阶段服务 harness（context.test.ts makeCtx 同款；contextComposer 注入真实替换件） */
function makeCtx(composer: TruncatingContextComposer, maxContextTokens = 8000): StageContext<any> {
  const base: Record<string, unknown> = {
    conversationStore: {
      readAll: vi.fn().mockResolvedValue([]),
      readFull: vi.fn().mockResolvedValue([]), // pool_context 存档召回（P0-2）
      append: vi.fn().mockResolvedValue(undefined),
      replace: vi.fn().mockResolvedValue(undefined),
    },
    toolRegistry: {
      getToolDefinitions: vi.fn().mockReturnValue([{ name: 'a', description: 'A' }]),
    },
    contextComposer: composer,
    compressor: { compress: vi.fn().mockResolvedValue(null) },
    summaryStore: { save: vi.fn().mockResolvedValue(undefined) },
    statsManager: {
      increment: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    configCenter: { get: vi.fn() },
    gitManager: {},
    maxContextTokens,
    sessionDir: '/tmp/replace-test',
    loopHooks: { emit: vi.fn().mockResolvedValue(undefined) },
    getRouter: () => ({
      name: 'normal',
      toolAllowlist: [],
      toolBlacklist: [],
      filterHistory: (h: Message[]) => h,
    }),
    kbState: { lastQuery: '' },
    outputHandler: null,
    bundleRegistry: undefined,
    personaDir: undefined,
  };
  return {
    iteration: 1,
    get: <T = unknown>(k: string) => base[k] as T | undefined,
    require: <T = unknown>(k: string) => base[k] as T,
    config: <T = Record<string, unknown>>() => ({}) as T,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
}

function providerStub() {
  return {
    getProviderType: () => 'deepseek',
    getModel: () => 'deepseek-chat',
    getCapabilities: () => ({ vision: false }),
  };
}

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: { type: 'text', text } };
}

function makeBigHistory(count: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    textMsg(i % 2 === 0 ? 'user' : 'assistant', `${'层'.repeat(50)}#${i}`),
  );
}

const stage = createContextStage();

describe('门槛 2 集成：内置 context 阶段消费 TruncatingContextComposer', () => {
  it('真实替换件注入后 stage 整体跑通：messages 压进预算、userInput 在尾、压缩阈值链路仍工作', async () => {
    const composer = new TruncatingContextComposer();
    const ctx = makeCtx(composer, 8000);
    const compress = (ctx as unknown as { require(k: string): unknown }).require('compressor') as {
      compress: ReturnType<typeof vi.fn>;
    };

    // 300 条 × ~52 token ≈ 15600 → 必触发激进截断；截断后落在 ~7200 内（>6000 → 触发压缩分支）
    const bigHistory = makeBigHistory(300);
    const state = {
      ...createTurnState({
        turn: 1,
        history: bigHistory,
        userInput: '这是新问题',
        session: { sessionDir: '/tmp/replace-test' } as never,
      }),
      activeProvider: providerStub(),
      // createTurnState 不派生这两个字段；显式给定，确保 stage 的 effectiveHistory 非空
      history: bigHistory,
      historyWithoutLastUser: bigHistory,
      uncompressedMsgs: bigHistory,
      pendingImageInjections: [],
      lastUserTextMsg: undefined,
      hasPendingToolCalls: false,
    } as unknown as TurnState;

    const out = await stage.run(state, ctx);

    // (a) 截断生效：输出估算 ≤ 90% 预算
    const total = out.messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    expect(total).toBeLessThanOrEqual(7200);
    // (b) userInput 保留在尾部（无重复追加）
    const lastMsg = out.messages[out.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    const lastText = (lastMsg.content as { text: string }).text;
    expect(lastText).toBe('这是新问题');
    // (c) 内置 stage 的记账字段与替换件口径一致
    expect(out.zoneBreakdown.total).toBe(total);
    expect(out.lastContextTokens).toBe(total);
    // (d) 阈值链路未被破坏：超 0.75 阈值 → 后台压缩被触发（mock 返回 null，链路不炸）
    expect(compress.compress).toHaveBeenCalled();
    // (e) 状态游标正常回写
    expect(out.uncompressedMsgs).toBeDefined();
    expect(out.pendingImageInjections).toEqual([]);
  });

  it('预算内不截断：替换件原样组装，与内置 stage 协作正常', async () => {
    const composer = new TruncatingContextComposer();
    const ctx = makeCtx(composer, 8000);
    const smallHistory = [textMsg('user', '短问题'), textMsg('assistant', '短回答')];

    const state = {
      ...createTurnState({
        turn: 1,
        history: smallHistory,
        userInput: '继续',
        session: { sessionDir: '/tmp/replace-test' } as never,
      }),
      activeProvider: providerStub(),
      history: smallHistory,
      historyWithoutLastUser: smallHistory,
      uncompressedMsgs: smallHistory,
      pendingImageInjections: [],
      lastUserTextMsg: undefined,
      hasPendingToolCalls: false,
    } as unknown as TurnState;

    const out = await stage.run(state, ctx);
    const msgs = out.messages;
    expect(msgs.length).toBeGreaterThanOrEqual(3); // 两条 history（system/thinking 无）+ userInput
    expect(out.zoneBreakdown.truncated).toBe(0);
  });
});
