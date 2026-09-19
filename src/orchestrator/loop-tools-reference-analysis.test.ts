/**
 * loop-tools-reference-analysis.test.ts — **批量路径**的引用自检 + diff 通知
 *
 * 任务单③明确要求的那条测试：**"批量路径 onDiff 能触发"**。
 * 背景（票③ + P0 同一片区域）：
 *   · 批量路径（executeTools）原先用 popD2(result.tool_use_id) 去查**按 filePath 索引**的账本
 *     ⇒ 永不命中 ⇒ onDiff **从未触发**（票③）；
 *   · 同一个错键又让那条 diff 留在了账本里，掩盖了 inline 路径"事实被先消费掉"的 P0。
 * 故本文件锁两件事：① 批量路径**也**产出引用自检注记（与 inline 路径同源）；
 * ② 批量路径的 onDiff **确实触发**且带对了文件（票③ 的回归）。
 *
 * 说明：这里直接调 runToolDispatch（批量路径入口），ctx 字面量照抄 loop-tools-gate.test.ts，
 * 用**真实** ToolRegistry + WriteTool（与端到端测试同源），不 mock 被测代码。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs2 from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runToolDispatch, type ToolExecContext } from './loop-tools.js';
import { ToolRegistry } from '../registry/tool.registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { ConversationStore } from '../memory/conversation.js';
import { LoopGuard } from '../repair/loop-guard.js';
import { bootstrapSecurity } from '../kernel/security/index.js';
import { WriteTool } from '../tools/write.js';
import type { ToolCall } from '../types.js';

const created: string[] = [];

/** 夹具契约：临时项目**必须带 .git 标记**（否则 findProjectRoot 上溯到用户目录，
 *  scanReferences 的 500 文件上限被系统目录吃光 ⇒ 永远扫不到项目内引用） */
function makeProject(): { root: string; target: string } {
  const root = fs2.mkdtempSync(path.join(os.tmpdir(), 'looptools-refanal-'));
  created.push(root);
  fs2.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs2.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs2.writeFileSync(
    path.join(root, 'src', 'caller.ts'),
    "import { targetFn } from './a.js';\n\nexport const v = targetFn();\n",
    'utf8',
  );
  return { root, target: path.join(root, 'src', 'a.ts') };
}

describe('批量路径（executeTools）：引用自检 + diff 通知', () => {
  let sessionDir: string;
  let ctx: ToolExecContext;
  let onDiff: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    bootstrapSecurity();
  });

  afterAll(() => {
    for (const d of created.splice(0)) {
      try { fs2.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeCtx(): ToolExecContext {
    sessionDir = fs2.mkdtempSync(path.join(os.tmpdir(), 'looptools-refanal-sess-'));
    created.push(sessionDir);
    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    onDiff = vi.fn();
    return {
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
  }

  it('① 批量路径产出引用自检注记（与 inline 路径同源）② onDiff 触发且带对文件（票③ 回归）', async () => {
    const { target } = makeProject();
    const content = 'export function targetFn(): number {\n  return 1;\n}\n';
    ctx = makeCtx();

    const call: ToolCall = { id: 'w_batch_1', name: 'write', input: { file_path: target, content } };
    const outcomes = await runToolDispatch(ctx, [call]);
    expect(outcomes[0]?.ok).toBe(true);

    // ① 注记落进对话（批量路径的消费者）
    const transcript = fs2.readFileSync(path.join(sessionDir, 'conversation.jsonl'), 'utf-8');
    expect(transcript).toContain('[References]');
    expect(transcript).toContain('targetFn');
    expect(transcript).toContain('caller.ts'); // 引用方文件被找到 ⇒ 说明扫描根正确（夹具 .git 生效）
    expect(transcript).not.toContain('[precise]'); // 无能力 ⇒ 兜底路径（与 inline 路径一致）

    // ② 票③ 回归：批量路径的 onDiff 必须触发，且文件名正确（原先用 tool_use_id 查 ⇒ 永不命中）
    expect(onDiff).toHaveBeenCalledTimes(1);
    const [, diffPath] = onDiff.mock.calls[0] as [string, string, unknown];
    expect(diffPath).toBe(target);
  });
});
