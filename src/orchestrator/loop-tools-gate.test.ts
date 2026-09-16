/**
 * 工具执行安全门禁测试 —— beforeToolExecute 拦截器剔除的工具调用
 * 必须真实拒绝执行并写回 denied 结果（修复"emit 丢弃返回值"的历史缝）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runToolDispatch, type ToolExecContext } from './loop-tools.js';
import { createLoopHookBus } from './loop-hooks.js';
import { ToolRegistry } from '../registry/tool.registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { ConversationStore } from '../memory/conversation.js';
import { LoopGuard } from '../repair/loop-guard.js';
import { bootstrapSecurity } from '../kernel/security/index.js';
import type { ToolCall } from '../types.js';

function stubTool(name: string): { name: string; description: string; inputSchema: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> } {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object' },
    execute: async (args) => `ran:${name}:${JSON.stringify(args?.command ?? args?.file_path ?? '')}`,
  };
}

function makeCall(name: string): ToolCall {
  return { id: `call_${name}`, name, input: { command: `echo ${name}`, file_path: `x/${name}.ts` } };
}

describe('runToolDispatch 安全门禁（beforeToolExecute 消费）', () => {
  let sessionDir: string;
  let ctx: ToolExecContext;

  beforeAll(() => {
    bootstrapSecurity();
    sessionDir = mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
    const registry = new ToolRegistry();
    registry.register(stubTool('echo') as never);
    registry.register(stubTool('other') as never);
    const bus = createLoopHookBus();
    // 模拟 permission-chain 形态的拦截器：剔除名为 other 的调用
    bus.intercept('beforeToolExecute', async (payload, next) => {
      const filtered = payload.calls.filter((c) => c.name !== 'other');
      return next({ ...payload, calls: filtered });
    });
    ctx = {
      outputHandler: null,
      sessionDir,
      turn: 1,
      loopHooks: bus,
      gitManager: { getRepoPath: () => sessionDir } as never,
      conversationStore: new ConversationStore(),
      configCenter: undefined,
      toolExecutor: new ToolExecutor(registry, 5000),
      toolRegistry: registry,
      resultBuffer: { getBufferDir: () => sessionDir, maybeBuffer: (s: string) => s } as never,
      abortController: null,
      dangerousTools: new Set(),
      allowlistTools: new Set(),
      allowedCommands: new Set(),
      loopGuard: new LoopGuard(),
      getUnrestricted: () => false,
      setUnrestricted: () => {},
      getPendingImpact: () => null,
      setPendingImpact: () => {},
      markMutation: () => {},
      hadMutation: () => false,
      addEvidence: () => {},
      evidenceCount: () => 0,
      inlineToolResults: new Map(),
    };
  });

  it('被拦截器剔除的调用不执行，且写回 denied 结果', async () => {
    const outcomes = await runToolDispatch(ctx, [makeCall('echo'), makeCall('other')]);
    const byId = new Map(outcomes.map((o) => [o.name, o]));
    expect(byId.get('echo')?.ok).toBe(true);
    expect(byId.get('other')?.ok).toBe(false);

    const transcript = readFileSync(path.join(sessionDir, 'conversation.jsonl'), 'utf-8');
    expect(transcript).toContain('ran:echo'); // 实际执行
    expect(transcript).not.toContain('ran:other'); // 未执行
    expect(transcript).toContain('blocked by beforeToolExecute hook'); // denied 结果写回
  });

  it('无拦截器时全部正常执行（快路径）', async () => {
    const bus2 = createLoopHookBus(); // 无任何挂载者
    const ctx2: ToolExecContext = { ...ctx, loopHooks: bus2, sessionDir: mkdtempSync(path.join(os.tmpdir(), 'gate-test-')) };
    const outcomes = await runToolDispatch(ctx2, [makeCall('echo'), makeCall('other')]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });
});

describe('runToolDispatch 执行侧工具包对称校验（治本）', () => {
  let sessionDir: string;
  let ctx: ToolExecContext;

  beforeAll(() => {
    sessionDir = mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-'));
    const registry = new ToolRegistry();
    registry.register(stubTool('echo') as never);  // 激活包内
    registry.register(stubTool('other') as never); // 激活包外
    const active = new Set(['echo']);
    ctx = {
      outputHandler: null,
      sessionDir,
      turn: 1,
      gitManager: { getRepoPath: () => sessionDir } as never,
      conversationStore: new ConversationStore(),
      configCenter: undefined,
      toolExecutor: new ToolExecutor(registry, 5000),
      toolRegistry: registry,
      resultBuffer: { getBufferDir: () => sessionDir, maybeBuffer: (s: string) => s } as never,
      abortController: null,
      dangerousTools: new Set(),
      allowlistTools: new Set(),
      allowedCommands: new Set(),
      loopGuard: new LoopGuard(),
      getUnrestricted: () => false,
      setUnrestricted: () => {},
      getPendingImpact: () => null,
      setPendingImpact: () => {},
      markMutation: () => {},
      hadMutation: () => false,
      addEvidence: () => {},
      evidenceCount: () => 0,
      inlineToolResults: new Map(),
      // 模拟 bundleRegistry 注入：仅 echo 在激活包内
      isToolAllowedByBundle: (name: string) => active.has(name),
    };
  });

  it('激活包外的工具被拦截不执行，写回明确的 bundle blocked 结果', async () => {
    const outcomes = await runToolDispatch(ctx, [makeCall('echo'), makeCall('other')]);
    const byId = new Map(outcomes.map((o) => [o.name, o]));
    expect(byId.get('echo')?.ok).toBe(true);
    expect(byId.get('other')?.ok).toBe(false);

    const transcript = readFileSync(path.join(sessionDir, 'conversation.jsonl'), 'utf-8');
    expect(transcript).toContain('ran:echo');   // 包内工具实际执行
    expect(transcript).not.toContain('ran:other'); // 包外工具未执行
    expect(transcript).toContain('not in the active tool bundle'); // 明确拒绝原因
  });

  it('isToolAllowedByBundle 未注入（undefined）时不拦截，保持既有行为', async () => {
    const ctx2: ToolExecContext = { ...ctx, isToolAllowedByBundle: undefined, sessionDir: mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-')) };
    const outcomes = await runToolDispatch(ctx2, [makeCall('echo'), makeCall('other')]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });
});
