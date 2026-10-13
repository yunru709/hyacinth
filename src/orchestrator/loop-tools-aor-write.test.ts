/**
 * AOR（全局放行）与工作区围栏的交互契约测试 —— 2026-10-13（孑遗选定方案①）。
 *
 * 背景：AOR 声称「所有未来工具调用不再需要许可」，但工作区围栏是在 `tool.execute`
 * **内部**判定的，根本不经过权限层 ⇒ 改造前 AOR 下越界写入照样撞墙（"全放行"名不副实）。
 * 现在 AOR 也把该目录记入 `approvedWriteRoots`，围栏据此放行。
 *
 * 本文件专门钉住一个**极易写错的点**：记录动作必须位于「`onPermissionRequest` 是否存在」
 * 的判断**之外**。TUI 渠道压根没有该通道（实测：只有 cli.ts / http-webhook.ts /
 * ui-protocol 实现了它），若把记录塞进块内，AOR 在 TUI 下就形同虚设 —— 而 TUI 正是
 * 没有别的批准途径的那个渠道，错在这里等于功能全废且不报错。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runToolDispatch, type ToolExecContext } from './loop-tools.js';
import { ToolRegistry } from '../registry/tool.registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { ConversationStore } from '../memory/conversation.js';
import { LoopGuard } from '../repair/loop-guard.js';
import { bootstrapSecurity } from '../kernel/security/index.js';
import type { ToolCall } from '../types.js';

function stubTool(name: string) {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object' },
    execute: async (args: Record<string, unknown>) => `ran:${name}:${String(args?.file_path ?? '')}`,
  };
}

function makeCtx(o: {
  sessionDir: string;
  root: string;
  unrestricted: boolean;
  approved: Set<string>;
  outputHandler?: ToolExecContext['outputHandler'];
}): ToolExecContext {
  const registry = new ToolRegistry();
  registry.register(stubTool('write') as never);
  return {
    outputHandler: o.outputHandler ?? null,
    sessionDir: o.sessionDir,
    turn: 1,
    gitManager: { getRepoPath: () => o.sessionDir } as never,
    conversationStore: new ConversationStore(),
    configCenter: undefined,
    toolExecutor: new ToolExecutor(registry, 5000),
    toolRegistry: registry,
    resultBuffer: { getBufferDir: () => o.sessionDir, maybeBuffer: (s: string) => s } as never,
    abortController: null,
    dangerousTools: new Set(['write']),
    allowlistTools: new Set(),
    allowedCommands: new Set(),
    loopGuard: new LoopGuard(),
    getUnrestricted: () => o.unrestricted,
    setUnrestricted: () => {},
    getPendingImpact: () => null,
    setPendingImpact: () => {},
    markMutation: () => {},
    hadMutation: () => false,
    addEvidence: () => {},
    evidenceCount: () => 0,
    inlineToolResults: new Map(),
    approvedWriteRoots: o.approved,
    workspaceFenceRoot: o.root,
    workspaceFenceExtraRoots: [],
  };
}

function writeCall(filePath: string): ToolCall {
  return { id: 'c1', name: 'write', input: { file_path: filePath } };
}

describe('AOR 与工作区围栏：AOR 下越界写入应被批准并放行', () => {
  let root: string;
  let outsideDir: string;
  let outsideFile: string;

  beforeAll(() => {
    bootstrapSecurity();
    root = mkdtempSync(path.join(os.tmpdir(), 'aor-root-'));
    outsideDir = mkdtempSync(path.join(os.tmpdir(), 'aor-outside-'));
    outsideFile = path.join(outsideDir, 'probe.txt');
  });

  it('① AOR 开 + 无确认通道（TUI 形态）⇒ 记入批准根，且调用照常执行', async () => {
    const approved = new Set<string>();
    const ctx = makeCtx({
      sessionDir: mkdtempSync(path.join(os.tmpdir(), 'aor-s1-')),
      root,
      unrestricted: true,
      approved,
      outputHandler: null, // ← 模拟 TUI：没有 onPermissionRequest
    });

    const outcomes = await runToolDispatch(ctx, [writeCall(outsideFile)]);

    // 记录动作发生在确认块之外 ⇒ 没有通道也生效
    expect([...approved]).toContain(outsideDir);
    // 且调用未被拦下（旧实现这里会被围栏在 execute 内拒绝）
    expect(outcomes[0]?.ok).toBe(true);
  });

  it('② 非 AOR + 无确认通道 ⇒ 不记批准根（越界仍需别的途径批准）', async () => {
    const approved = new Set<string>();
    const ctx = makeCtx({
      sessionDir: mkdtempSync(path.join(os.tmpdir(), 'aor-s2-')),
      root,
      unrestricted: false,
      approved,
      outputHandler: null,
    });

    await runToolDispatch(ctx, [writeCall(outsideFile)]);

    expect(approved.size).toBe(0);
  });

  it('③ 非 AOR + 有通道且用户选 yes ⇒ 记入批准根', async () => {
    const approved = new Set<string>();
    const asked: string[] = [];
    const ctx = makeCtx({
      sessionDir: mkdtempSync(path.join(os.tmpdir(), 'aor-s3-')),
      root,
      unrestricted: false,
      approved,
      outputHandler: {
        onText: () => {},
        onStatus: () => {},
        onPermissionRequest: async (toolName: string) => {
          asked.push(toolName);
          return 'yes';
        },
      } as never,
    });

    const outcomes = await runToolDispatch(ctx, [writeCall(outsideFile)]);

    expect(asked).toContain('write'); // 越界写入确实走到了确认
    expect([...approved]).toContain(outsideDir);
    expect(outcomes[0]?.ok).toBe(true);
  });

  it('④ 工作区内的写入既不触发确认，也不记批准根（不误伤）', async () => {
    const approved = new Set<string>();
    const asked: string[] = [];
    const ctx = makeCtx({
      sessionDir: mkdtempSync(path.join(os.tmpdir(), 'aor-s4-')),
      root,
      unrestricted: false,
      approved,
      outputHandler: {
        onText: () => {},
        onStatus: () => {},
        onPermissionRequest: async (toolName: string) => {
          asked.push(toolName);
          return 'yes';
        },
      } as never,
    });

    const outcomes = await runToolDispatch(ctx, [writeCall(path.join(root, 'inside.txt'))]);

    expect(outcomes[0]?.ok).toBe(true);
    expect(approved.size).toBe(0);
  });

  it('⑤ 应答为 aor 时当次即记入批准根（回归：\'aor\' 曾漏在记录条件外，害得用户要按两次）', async () => {
    const approved = new Set<string>();
    const ctx = makeCtx({
      sessionDir: mkdtempSync(path.join(os.tmpdir(), 'aor-s5-')),
      root,
      unrestricted: false, // ← 调用前 AOR 未开：正是「本次才开 AOR」那一击
      approved,
      outputHandler: {
        onText: () => {},
        onStatus: () => {},
        onPermissionRequest: async () => 'aor',
      } as never,
    });

    const outcomes = await runToolDispatch(ctx, [writeCall(outsideFile)]);

    // 必须**当次**就记录 —— 块外的 AOR 记录点此刻还看到 unrestrict=false
    // （setUnrestricted 在 await 之后才调用），全靠确认分支里的 'aor' 支兜住。
    // 漏掉这条断言，就等着用户按第二次。
    expect([...approved]).toContain(outsideDir);
    expect(outcomes[0]?.ok).toBe(true);
  });
});
