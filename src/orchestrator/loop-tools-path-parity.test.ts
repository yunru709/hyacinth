/**
 * loop-tools-path-parity.test.ts — **差分护栏**：两条工具执行路径的后置处理必须一致
 *
 * ── 它防的是什么（2026-09-19）────────────────────────────────────────────
 * 同一件逻辑在仓库里有**两条物理路径**：
 *   · 批量：`runToolDispatch(ctx, calls)`      —— provider 没在流内发 TOOL_USE 时走这条
 *   · inline：`flushInlineResults(ctx, calls)` —— **真实厂商的常态**（流内发 TOOL_USE）
 * 今晚的 P0 正是"消费者只挂在一条路径上"（引用自检只在批量路径 ⇒ inline 路径完全不触发 ✗）。
 * 当时修好了，但**没有任何东西拦住下一个人只改一条** ✗ —— 这个文件就是那道闸。
 *
 * ── 断言什么 ───────────────────────────────────────────────────────────
 * 同一份夹具、同一个工具调用，分别驱动两条路径，断言 **落进对话的 tool_result 逐字相同**
 * （夹具路径先归一化再比 ✓）。任何"只给一条路径加消费者"的改动都会让两边不等 ⇒ 当场变红 ✓。
 * 并且带**防假绿**断言：两边都必须含 `[References]` —— 否则"两边都空"也会相等 ✓✗。
 *
 * ── 射程（有意划清）────────────────────────────────────────────────────
 * 覆盖：**后置序列**（清单驱动的注记 / 依赖影响面 / 证据账本 / diff 消费收尾）。
 * 不覆盖：diff 的 **UI 通知** —— 它的 inline 触发点在**执行处**（loop-tools.ts:540，未被本文件驱动）。
 *         那条对称性由另外两个测试守着：批量侧在 `loop-tools-post-consumers.test.ts`（断言 onDiff ✓），
 *         inline 侧在 `loop-reference-analysis.test.ts`（真跑 `run()` 端到端 ✓）。
 *
 * ── 为什么这样驱动 inline（忠实性说明）────────────────────────────────
 * 真实 inline 流程 = 执行处跑工具 → 存进 `ctx.inlineToolResults` → `flushInlineResults` 后处理。
 * 这里照抄同一形状：用**同一个 `WriteTool`**取原始输出（与批量路径执行的是同一个工具 ✓），
 * 再交给 `flushInlineResults` —— 也就是说：**被比较的是后处理这一段**，正是可能跑偏的那段 ✓。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runToolDispatch, flushInlineResults, type ToolExecContext } from './loop-tools.js';
import { ToolRegistry } from '../registry/tool.registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { ConversationStore } from '../memory/conversation.js';
import { LoopGuard } from '../repair/loop-guard.js';
import { bootstrapSecurity } from '../kernel/security/index.js';
import { WriteTool } from '../tools/write.js';
import type { ToolCall } from '../types.js';

/** 诊断模块打桩：本文件不关心诊断内容，只要求两条路径走**同一份**清单 ⇒ 结果可比 */
vi.mock('../tools/diagnostics.js', () => ({
  maybeRunDiagnostics: vi.fn(async () => 'DIAG-MARKER'),
}));

const created: string[] = [];

/** 夹具契约：临时项目必须带 .git 标记（否则扫描根会失控 —— 见 reference-analysis-scanroot.test.ts） */
function makeProject(): { root: string; target: string; caller: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-parity-'));
  created.push(root);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const caller = path.join(root, 'src', 'caller.ts');
  fs.writeFileSync(caller, "import { targetFn } from './a.js';\n\nexport const v = targetFn();\n", 'utf8');
  return { root, target: path.join(root, 'src', 'a.ts'), caller };
}

const CONTENT = 'export function targetFn(): number {\n  return 1;\n}\n';

describe('两条执行路径的后置处理必须一致（差分护栏）', () => {
  beforeAll(() => { bootstrapSecurity(); });

  afterAll(() => {
    for (const d of created.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeCtx(): { ctx: ToolExecContext; sessionDir: string; onDiff: ReturnType<typeof vi.fn> } {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-parity-sess-'));
    created.push(sessionDir);
    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    const onDiff = vi.fn();
    const ctx: ToolExecContext = {
      outputHandler: { onToolResult: vi.fn(), onDiff } as never,
      sessionDir,
      turn: 1,
      loopHooks: undefined,
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
    return { ctx, sessionDir, onDiff };
  }

  /** 读回落进对话的 tool_result 文本 */
  function resultText(sessionDir: string): string {
    const raw = fs.readFileSync(path.join(sessionDir, 'conversation.jsonl'), 'utf-8');
    const out: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const m = JSON.parse(line) as { content?: { type?: string; content?: unknown } };
      if (m.content?.type === 'tool_result') out.push(String(m.content.content ?? ''));
    }
    return out.join('\n---\n');
  }

  /** 把夹具根抹平，只比较"两条路径产出的差异"（夹具路径本身当然不同） */
  const normalize = (s: string, root: string): string => s.split(root).join('<ROOT>');

  it('同一个 write 调用：批量路径与 inline 路径的 tool_result 逐字相同', async () => {
    const a = makeProject();
    const b = makeProject();

    // ── A. 批量路径：runToolDispatch 自己执行工具 + 后处理 ──
    const ca = makeCtx();
    const callA: ToolCall = { id: 'w_parity_a', name: 'write', input: { file_path: a.target, content: CONTENT } };
    await runToolDispatch(ca.ctx, [callA]);
    const textA = normalize(resultText(ca.sessionDir), a.root);

    // ── B. inline 路径：照抄真实形状（执行处先跑工具 → 存 map → flushInlineResults 后处理）──
    const cb = makeCtx();
    const callB: ToolCall = { id: 'w_parity_b', name: 'write', input: { file_path: b.target, content: CONTENT } };
    const rawResult = await new WriteTool().execute({ file_path: b.target, content: CONTENT });
    cb.ctx.inlineToolResults.set(callB.id, { content: rawResult, isError: false });
    await flushInlineResults(cb.ctx, [callB]);
    const textB = normalize(resultText(cb.sessionDir), b.root);

    // 防假绿：两边都必须真的产出了东西（否则"两边都空"也会相等 ✗）
    expect(textA, '批量路径没产出 —— 断言会变成空过').toContain('[References]');
    expect(textB, 'inline 路径没产出 —— 断言会变成空过').toContain('[References]');
    expect(textA).toContain('caller.ts');
    expect(textB).toContain('caller.ts');

    // 差分本体：**逐字相同**。只给一条路径加消费者/改顺序，这里立刻不等 ⇒ 变红 ✓
    expect(textB, '两条路径的后置产出不一致 —— 有东西只挂在了其中一条路径上').toBe(textA);
  });
});
