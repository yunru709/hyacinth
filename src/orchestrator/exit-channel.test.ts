/**
 * 出口配置 × 渠道类型 集成测试（2026-11-08 · QQ 内心独白泄漏事故的守卫）
 *
 * 事故链（实测会话 qq_20261108-141521-9f81）：
 *   ① auto.json 全局 enabled=true ⇒ getExitConfig() 给**所有**会话返回
 *      `{ exits: ['suspend'] }` ⇒ QQ 会话每轮被注入「本会话只允许 suspend 作为出口」
 *   ② 模型注意力全落在"我得赶紧挂起" ⇒ 思考完直接调工具，本轮没有 TEXT 事件
 *   ③ llm.ts 的 thinking-only 兜底把整段思考提成正文 ⇒ 内心独白发给了用户
 *
 * 本文件锁定第 ① 步的修复：**持久消息渠道不继承全局 auto**。
 * （第 ③ 步的修复在 stages/llm.test.ts 的「thinking + tool_use」用例。）
 *
 * 判据来自渠道自己登记的能力声明（session-channel.ts 能力注册表），
 * 而非渠道名字面量 —— 核心不认识任何具体渠道。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './loop.js';
import type { AgentLoopServices } from './loop.js';
import type { Provider } from '../provider/interface.js';
import {
  registerChannelPrefix,
  registerChannelCapabilities,
  clearChannelCapabilities,
  unregisterChannelPrefix,
} from '../session-channel.js';

// 全局 auto 恒为开 —— 正是事故现场条件
vi.mock('./auto-global.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-global.js')>();
  return {
    ...actual,
    loadGlobalAuto: () => ({ enabled: true }),
    saveGlobalAuto: () => true,
  };
});

const tmpDirs: string[] = [];
function tmpdir(name: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-channel-'));
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  tmpDirs.push(base);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  clearChannelCapabilities();
  unregisterChannelPrefix('qq_');
  unregisterChannelPrefix('tui_');
});

function makeProvider(): Provider {
  return {
    getProviderType: () => 'deepseek',
    getModel: () => 'deepseek-chat',
    getCapabilities: () => ({ vision: false }),
    setThinking: vi.fn(),
    createStream: vi.fn().mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', content: '你好' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    })),
  } as unknown as Provider;
}

function makeServices(provider: Provider): AgentLoopServices {
  return {
    provider,
    contextComposer: {
      compose: vi.fn().mockResolvedValue({
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
        zoneBreakdown: { total: 100 },
      }),
      activeConditions: new Set<string>(),
    },
    compressor: { compress: vi.fn().mockResolvedValue(null) } as never,
    orchestrator: {} as never,
    toolExecutor: {} as never,
    toolRegistry: {
      register: vi.fn(),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getAll: vi.fn().mockReturnValue([]),
    } as never,
    conversationStore: {
      readAll: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue(undefined),
      replace: vi.fn().mockResolvedValue(undefined),
    } as never,
    eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
    statsManager: {
      get: vi.fn().mockResolvedValue({ input_tokens: 0, output_tokens: 0, cache_turns: [] }),
      update: vi.fn().mockResolvedValue(undefined),
      increment: vi.fn().mockResolvedValue(undefined),
    } as never,
    summaryStore: {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    } as never,
    flowRegistry: { getActive: () => null } as never,
  } as unknown as AgentLoopServices;
}

type Gates = {
  resolveStopGates(r: { stop: boolean; stopReason?: string }): Promise<{ stop: boolean; stopReason?: string }>;
};

function makeLoop(sessionDir: string): AgentLoop {
  return new AgentLoop(makeServices(makeProvider()), { sessionDir });
}

describe('全局 auto × 渠道类型（2026-11-08 事故守卫）', () => {
  it('持久消息渠道（qq，persistent）不继承全局 auto ⇒ end_turn 正常结束', async () => {
    registerChannelPrefix('qq_', 'qq');
    registerChannelCapabilities('qq', { persistent: true });

    const loop = makeLoop(tmpdir('qq_20261108-000000-test'));
    const out = await (loop as unknown as Gates).resolveStopGates({ stop: true, stopReason: 'end_turn' });

    // 未被 end_turn-blocked 拦下 —— 这正是修复点
    expect(out.stop).toBe(true);
    expect(out.stopReason).toBe('end_turn');
  });

  it('本地渠道（tui，localDefault）仍继承全局 auto ⇒ end_turn 被拦（自主模式不回退）', async () => {
    registerChannelPrefix('tui_', 'tui');
    registerChannelCapabilities('tui', { localDefault: true });

    const loop = makeLoop(tmpdir('tui_20261108-000000-test'));
    const out = await (loop as unknown as Gates).resolveStopGates({ stop: true, stopReason: 'end_turn' });

    expect(out.stop).toBe(false);
    expect(out.stopReason).toBe('exit_blocked');
  });

  it('未登记能力的渠道 ⇒ 按旧行为继承全局 auto（零回归）', async () => {
    const loop = makeLoop(tmpdir('unknown_20261108-000000-test'));
    const out = await (loop as unknown as Gates).resolveStopGates({ stop: true, stopReason: 'end_turn' });

    expect(out.stop).toBe(false);
    expect(out.stopReason).toBe('exit_blocked');
  });

  it('会话级 exit.json 对消息渠道仍生效（可在单会话显式开启自主）', async () => {
    const { saveExitConfig } = await import('./exit-config.js');
    registerChannelPrefix('qq_', 'qq');
    registerChannelCapabilities('qq', { persistent: true });

    const dir = tmpdir('qq_20261108-000000-explicit');
    saveExitConfig(dir, { exits: ['suspend'] }); // 显式声明：只允许 suspend

    const loop = makeLoop(dir);
    const out = await (loop as unknown as Gates).resolveStopGates({ stop: true, stopReason: 'end_turn' });

    // 会话级优先 ⇒ 依然拦截（消息渠道也能"显式"自主）
    expect(out.stop).toBe(false);
    expect(out.stopReason).toBe('exit_blocked');
  });
});
