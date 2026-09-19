/**
 * loop-tools-post-consumers.test.ts — **批量路径**的核心后置消费者
 *
 * 装两个消费者（都属"联动体系"）：
 *   ① 引用自检：批量路径产出注记；且 diff 通知**触发**（票③ 回归）
 *   ② 写后诊断（#2 迁移）：从 write/edit 里搬出来的后置消费者 —— 判据是**行为**，不是实现
 *
 * 出处：任务单③ 要求"补一条『批量路径 onDiff 能触发』的测试"；用户裁定"都统一进联动体系"。
 *
 * 诊断消费者的**关键判据**（"真的写了才诊断"）：以 diff 账本有无条目为准 ——
 * 被读门控**拒绝**的写不推 diff ⇒ 不应触发诊断（本文件第二条用例锁的正是它）。
 * 故这里 vi.mock 掉诊断模块，用标记串观察"有没有被调用"，不真跑 tsc（慢且不稳）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
import { defaultToolLinks, setCurrentToolLinks } from '../utils/tool-links.js';
import type { ToolCall } from '../types.js';

/** 诊断模块打桩：只关心"被调用了没有" */
vi.mock('../tools/diagnostics.js', () => ({
  maybeRunDiagnostics: vi.fn(async () => 'DIAG-MARKER'),
}));

const created: string[] = [];

/** 夹具契约：临时项目**必须带 .git 标记**（否则 findProjectRoot 上溯到用户目录，
 *  scanReferences 的 500 文件上限被系统目录吃光 ⇒ 永远扫不到项目内引用） */
function makeProject(): { root: string; target: string } {
  const root = fs2.mkdtempSync(path.join(os.tmpdir(), 'looptools-postcons-'));
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

describe('批量路径（runToolDispatch）：核心后置消费者', () => {
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

  beforeEach(() => {
    sessionDir = fs2.mkdtempSync(path.join(os.tmpdir(), 'looptools-postcons-sess-'));
    created.push(sessionDir);
    const registry = new ToolRegistry();
    registry.register(new WriteTool());
    onDiff = vi.fn();
    ctx = {
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
  });

  const transcript = (): string => fs2.readFileSync(path.join(sessionDir, 'conversation.jsonl'), 'utf-8');

  it('① 引用自检注记产出 + ② onDiff 触发且带对文件（票③ 回归）', async () => {
    const { target } = makeProject();
    const content = 'export function targetFn(): number {\n  return 1;\n}\n';

    const call: ToolCall = { id: 'w_batch_1', name: 'write', input: { file_path: target, content } };
    const outcomes = await runToolDispatch(ctx, [call]);
    expect(outcomes[0]?.ok).toBe(true);

    const text = transcript();
    expect(text).toContain('[References]');
    expect(text).toContain('targetFn');
    expect(text).toContain('caller.ts'); // 引用方文件被找到 ⇒ 扫描根正确（夹具 .git 生效）
    expect(text).not.toContain('[precise]'); // 无能力 ⇒ 兜底路径

    expect(onDiff).toHaveBeenCalledTimes(1);
    const [, diffPath] = onDiff.mock.calls[0] as [string, string, unknown];
    expect(diffPath).toBe(target);
  });

  it('#2 写后诊断：真写了才诊断（成功写入 → 有诊断；被读门控拒绝 → 不诊断）', async () => {
    const { target } = makeProject();
    const content = 'export function targetFn(): number {\n  return 1;\n}\n';

    // (a) 成功写入（新文件 ⇒ 读门控放行 ⇒ 推了 diff）⇒ 诊断触发
    await runToolDispatch(ctx, [{ id: 'w_ok', name: 'write', input: { file_path: target, content } }]);
    const okText = transcript();
    expect(okText).toContain('DIAG-MARKER');
    // 顺序保持：诊断在引用自检注记**之前**（现状是"工具结果已含诊断，其后才是引用注记"）
    expect(okText.indexOf('DIAG-MARKER')).toBeLessThan(okText.indexOf('[References]'));

    // (b) 被拒绝的写：目标文件**已存在且未读过** ⇒ 读门控拒绝 ⇒ 未推 diff ⇒ **不应**诊断
    const { target: existing } = makeProject();
    fs2.writeFileSync(existing, 'export const old = 1;\n', 'utf8');
    const refused = await runToolDispatch(ctx, [
      { id: 'w_refused', name: 'write', input: { file_path: existing, content } },
    ]);
    expect(refused[0]?.ok).toBe(true); // 拒绝也是"正常返回值"（工具没抛错）

    // 关键断言：整份对话里 DIAG-MARKER 仍只出现**一次**（只有 (a) 那次）——
    // 若诊断判据退化成"只要调用了 write/edit 就跑"，这里会变成两次。
    const total = transcript().split('DIAG-MARKER').length - 1;
    expect(total).toBe(1);
  });

  it('#4 清单驱动：写 enabled:false ⇒ 该处理器不再运行（"改一处完成断线"的机器化证据）', async () => {
    const { target } = makeProject();
    const content = 'export function targetFn(): number {\n  return 1;\n}\n';

    // 覆盖当前清单：关掉诊断、保留引用自检（正是把 ~/.agent/tool-links.json 换成这份的等价物）
    setCurrentToolLinks({
      version: 1,
      links: [
        { on: 'afterToolExecute:write', handler: 'core.diagnostics-append', enabled: false },
        { on: 'afterToolExecute:write', handler: 'core.references-append', enabled: true },
      ],
    });
    try {
      await runToolDispatch(ctx, [{ id: 'w_cfg', name: 'write', input: { file_path: target, content } }]);
      const text = transcript();
      // 关掉的那条**不再运行**（默认清单里它是跑的 —— 见上一条用例的 DIAG-MARKER 断言）
      expect(text).not.toContain('DIAG-MARKER');
      // 保留的那条照常（证明不是"整份清单失灵"，而是**按条**生效）
      expect(text).toContain('[References]');
    } finally {
      // 还原（清单是**进程级**持有者，不还原会污染同文件其他用例 —— 这也是它被设计成
      // get/set 两个函数、而不是隐式全局的原因）
      setCurrentToolLinks(defaultToolLinks());
    }
  });
});
