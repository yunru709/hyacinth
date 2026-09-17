/**
 * P1 M3 · input 阶段模块测试（builtin:input-normalize）。
 * 覆盖：userInput 提取 / 续轮判定 / 剥离 lastUser / ephemeral 旁白覆盖 /
 * companion 表达文本化 / 契约声明满足槽位 requires。
 */
import { describe, it, expect, vi } from 'vitest';
import { createInputStage, INPUT_STAGE_ID } from './input.js';
import { checkContract, type SlotSpec, type StageContext } from '../../kernel/pipeline.js';
import { createTurnState, type TurnState } from '../turn-state.js';
import { extractTextContent } from '../../utils/misc.js';
import type { Message } from '../../types.js';

function makeCtx(services: Record<string, unknown>): StageContext<any> {
  return {
    iteration: 1,
    get: <T = unknown>(k: string) => services[k] as T | undefined,
    require: <T = unknown>(k: string) => services[k] as T,
    config: <T = Record<string, unknown>>() => ({}) as T,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
}

const msg = (role: Message['role'], text: string): Message => ({ role, content: [{ type: 'text', text }] });
const toolResultMsg = (text: string, id = 'say1'): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: text }] as never,
});

/** 构造一个带 companion_say tool_use 的 assistant 消息（表达轮次） */
const sayMsg = (): Message => ({
  role: 'assistant',
  content: [
    { type: 'tool_use', id: 'say1', name: 'companion_say', input: { text: '你好呀', think: '她今天心情不错', action: '微笑' } },
  ] as never,
});

function baseState(): TurnState {
  return createTurnState({
    turn: 1,
    history: [],
    userInput: '',
    session: {
      sessionDir: '/tmp/test-session',
      currentSummary: undefined,
      recentToolNames: [],
      activePlan: undefined,
    } as never,
  });
}

const stage = createInputStage();

describe('input 阶段（builtin:input-normalize）', () => {
  it('普通模式：提取最后一条 user 文本为 userInput，剥离它作为 compose 历史', async () => {
    const history: Message[] = [
      msg('user', '你好'),
      msg('assistant', '嗨！'),
      msg('user', '帮我写个函数'),
    ];
    const ctx = makeCtx({
      conversationStore: { readAll: vi.fn().mockResolvedValue(history) },
      sessionDir: '/tmp/test-session',
    });

    const st = await stage.run(baseState(), ctx);

    expect(st.userInput).toBe('帮我写个函数');
    expect(st.history).toBe(history); // 原始历史保留
    expect(st.historyWithoutLastUser.map((m) => extractTextContent(m.content))).toEqual(['你好', '嗨！']);
    expect(st.uncompressedMsgs).toBe(history); // 普通模式：不文本化
    expect(st.hasPendingToolCalls).toBe(false);
    expect(st.ephemeralInput).toBeNull();
  });

  it('续轮：历史含未消费 tool_use → hasPendingToolCalls=true、userInput 清空、不剥离历史', async () => {
    const history: Message[] = [
      msg('user', '查一下天气'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'weather', input: {} }] as never },
      toolResultMsg('晴，25 度', 'w1'),
    ];
    const ctx = makeCtx({
      conversationStore: { readAll: vi.fn().mockResolvedValue(history) },
      sessionDir: '/tmp/test-session',
    });

    const st = await stage.run(baseState(), ctx);

    expect(st.hasPendingToolCalls).toBe(true);
    expect(st.userInput).toBe(''); // 末尾不是新 user 文本 → 续轮，清空防重复注入
    expect(st.historyWithoutLastUser).toBe(history); // 续轮不剥离
  });
  it('回归：历史含早期 tool_use、末尾又是新 user 文本 → 仍须剥离（防重复注入）', async () => {
    // 这是「同一条用户消息被注入两次」的真实形态：会话只要用过工具（任意一轮），
    // hasPendingToolCalls 就恒为真。旧实现拿它当「本轮是否续轮」的剥离判据 →
    // raw 全量保留（含末尾新 user 消息），同时 userInput 又注入同一条。
    const history: Message[] = [
      msg('user', '帮我查天气'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'weather', input: {} }] as never },
      toolResultMsg('晴，25 度', 'w1'),
      msg('assistant', '今天晴，25 度'),
      msg('user', '那明天呢'),
    ];
    const ctx = makeCtx({
      conversationStore: { readAll: vi.fn().mockResolvedValue(history) },
      sessionDir: '/tmp/test-session',
    });

    const st = await stage.run(baseState(), ctx);

    expect(st.userInput).toBe('那明天呢');
    // 宽判据本身仍为真（context 阶段据此决定是否 filterHistory），但它不再参与剥离判定
    expect(st.hasPendingToolCalls).toBe(true);
    // 关键：末尾那条新 user 消息必须被剥离，否则 compose 后与 userInput 重复
    expect(st.historyWithoutLastUser.includes(history[4])).toBe(false);
    expect(st.historyWithoutLastUser).toHaveLength(4);
  });



  it('瞬态旁白轮：ephemeralInput 覆盖 userInput 并置 null（一次性消费标记）', async () => {
    const history: Message[] = [msg('user', '上一轮输入')];
    const ctx = makeCtx({
      conversationStore: { readAll: vi.fn().mockResolvedValue(history) },
      sessionDir: '/tmp/test-session',
    });
    const state = baseState();
    state.ephemeralInput = '（旁路 LLM 瞬态产出）';

    const st = await stage.run(state, ctx);

    expect(st.userInput).toBe('（旁路 LLM 瞬态产出）');
    expect(st.ephemeralInput).toBeNull(); // 已消费 → 调用方清空 router 残留
    expect(st.historyWithoutLastUser).toBe(history); // 旁白轮不剥离
  });

  it('陪伴模式：companion_say 表达被文本化（uncompressedMsgs），普通历史保持原样', async () => {
    const history: Message[] = [
      msg('user', '在吗'),
      sayMsg(),
      toolResultMsg('{"as":"speak"}'),
    ];
    const ctx = makeCtx({
      conversationStore: { readAll: vi.fn().mockResolvedValue(history) },
      sessionDir: '/tmp/test-session',
    });
    const state = baseState();
    state.companionMode = true;

    const st = await stage.run(state, ctx);

    // 文本化：companion_say 的 tool_use 块被渲染成 [微笑]（心声）台词 并入 assistant 文本
    const assistant = st.uncompressedMsgs.find((m) => m.role === 'assistant')!;
    const text = assistant.content as unknown as Array<{ type: string; text?: string }>;
    const joined = Array.isArray(text) ? text.map((c) => c.text ?? '').join('') : '';
    expect(joined).toContain('[微笑]');
    expect(joined).toContain('（她今天心情不错）');
    expect(joined).toContain('你好呀');
    // 孤儿 tool_result 被摘除
    expect(st.uncompressedMsgs.some((m) => JSON.stringify(m.content).includes('tool_result'))).toBe(false);
  });

  it('契约：模块声明满足配置骨架 input 槽位的 requires', () => {
    const slot: SlotSpec = {
      id: 'input',
      impl: INPUT_STAGE_ID,
      requires: { reads: ['history', 'userInput'], writes: ['userInput'] },
    };
    expect(checkContract(slot, stage)).toEqual([]);
  });
});
