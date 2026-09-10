/**
 * memory-maintenance.test.ts —— 记忆闭环证据锁定（「仅测试+归档」）
 *
 * 背景：审查称记忆系统「无跨会话检索/自动摘要」——实为盲区（只看了
 * memory-store.ts 57 行）：完整闭环已存在——ContextSource 'memory'
 * 每轮注入 Zone + bypass postTurn.reviewAndRemember（LLM 高门槛提炼 →
 * memory_* 工具落盘）。本测试锁定 postTurn 记忆维护链路：
 *  LLM 决定 memory_add → executeTool → memory.md 落盘（`- ` 条目格式）。
 *
 * 用 stub provider（createStream 首轮 TOOL_USE memory_add、次轮 TEXT OK），
 * 不触真实 LLM。临时 memory.md 用 mkdtemp（不删，de-flake 教训）。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextOrchestrator } from './index.js';
import type { PostTurnContext } from '../types.js';
import type { ModelRouterLike } from '../base.js';

// ── stub provider ──────────────────────────────────────────────────

interface StubPlan {
  /** 每次 createStream 调用输出的流事件（按调用序号取） */
  rounds: Array<Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown>; content?: string; reason?: string }>>;
}

function makeProvider(plan: StubPlan) {
  let call = 0;
  const createStream = vi.fn().mockImplementation(async function* () {
    const events = plan.rounds[Math.min(call, plan.rounds.length - 1)] ?? [];
    call++;
    for (const e of events) {
      yield e;
    }
  });
  const provider = { createStream } as never;
  return { provider, createStream };
}

function makeRouter(provider: never): ModelRouterLike {
  return { getProvider: () => provider } as unknown as ModelRouterLike;
}

function postTurnCtx(over: Partial<PostTurnContext> = {}): PostTurnContext {
  return {
    userInput: '我平时喜欢研究分布式系统架构。',
    assistantOutput: '了解了。',
    history: [],
    toolCallsThisTurn: [],
    isLastIteration: true,
    sessionId: 'mem-test-1',
    ...over,
  };
}

// ── 测试 ────────────────────────────────────────────────────────────

describe('ContextOrchestrator postTurn 记忆维护（闭环证据）', () => {
  it('LLM 判定有值得记的内容 → memory_add 落盘（`- ` 条目格式）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-maint-'));
    const memoryPath = path.join(dir, 'memory.md');

    // 首轮流：TOOL_USE memory_add；次轮流：纯文本 OK（无工具 → 循环结束）
    const { provider } = makeProvider({
      rounds: [
        [
          { type: 'TOOL_USE', id: 't1', name: 'memory_add', input: { text: '用户偏好研究分布式系统架构' } },
          { type: 'STOP', reason: 'tool_use' },
        ],
        [{ type: 'TEXT', content: 'OK' }, { type: 'STOP', reason: 'end_turn' }],
      ],
    });

    const orch = new ContextOrchestrator(memoryPath);
    orch.setModelRouter(makeRouter(provider as never));
    await orch.start();
    await orch.postTurn(postTurnCtx());

    const content = fs.readFileSync(memoryPath, 'utf-8');
    expect(content).toContain('- 用户偏好研究分布式系统架构');
    expect(content.startsWith('# 记忆')).toBe(true); // orchestrator 维护的文件格式
  });

  it('LLM 判定无值得记的 → 不写入（高门槛行为）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-maint-'));
    const memoryPath = path.join(dir, 'memory.md');

    // 两次流都只有文本（无工具调用）
    const { provider } = makeProvider({
      rounds: [
        [{ type: 'TEXT', content: 'OK' }, { type: 'STOP', reason: 'end_turn' }],
      ],
    });

    const orch = new ContextOrchestrator(memoryPath);
    orch.setModelRouter(makeRouter(provider as never));
    await orch.start();
    await orch.postTurn(postTurnCtx({ userInput: '今天天气不错。' }));

    expect(fs.existsSync(memoryPath)).toBe(false); // 无记忆写入 → 文件不产生
  });

  it('memory 文件已有条目时 postTurn 带上下文（去重基础：读入现有记忆）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-maint-'));
    const memoryPath = path.join(dir, 'memory.md');
    // 预置一条已有记忆
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(memoryPath, '# 记忆\n- 已有记忆：用户是孑遗\n');

    // LLM 判定更新 → memory_update（走旧文本匹配）
    const { provider } = makeProvider({
      rounds: [
        [
          { type: 'TOOL_USE', id: 't2', name: 'memory_update', input: { old_text: '已有记忆：用户是孑遗', new_text: '已有记忆：用户是孑遗（架构师）' } },
          { type: 'STOP', reason: 'tool_use' },
        ],
        [{ type: 'TEXT', content: 'OK' }, { type: 'STOP', reason: 'end_turn' }],
      ],
    });

    const orch = new ContextOrchestrator(memoryPath);
    orch.setModelRouter(makeRouter(provider as never));
    await orch.start();
    await orch.postTurn(postTurnCtx());

    const content = fs.readFileSync(memoryPath, 'utf-8');
    expect(content).toContain('- 已有记忆：用户是孑遗（架构师）');
    expect(content).not.toContain('\n- 已有记忆：用户是孑遗\n'); // 旧条目被替换
  });
});
