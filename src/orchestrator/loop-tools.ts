/**
 * 工具执行器（B1 拆出）——从 AgentLoop 抽出的工具执行家族。
 *
 * 原为 loop.ts 的四个私有方法：executeTools / executeSingleToolInline /
 * flushInlineToolResults / isCommandAllowed（~378 行）。
 * 拆法：模块级函数 + 执行上下文对象（ToolExecContext），loop 方法体变薄壳委托。
 * 行为零变更：本文件是纯搬移，逻辑与注释保留原样，仅把 `this.xxx` 改为 `ctx.xxx`。
 *
 * 注意：与 loop.ts 存在 type-only 循环依赖（本文件 type import OutputHandler，
 * 运行时被擦除，安全）。避免值 import loop.ts。
 */
import path from 'node:path';
import type { OutputHandler } from './loop.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConversationStore } from '../memory/conversation.js';
import { appendEvent } from '../memory/events.js';
import type { Message, ToolCall, ToolResult, ToolResultContent } from '../types.js';
import type { DependencyAnalyzer } from '../dependency/analyzer.js';
import { isFlowTool } from '../tools/flow.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { LoopGuard, isMutating, ToolGuard } from '../repair/loop-guard.js';
import { isWriteTool, isMutatingTool } from '../tools/side-effect.js';
import { getCurrentToolLinks, resolveToolLinks } from '../utils/tool-links.js';
import { buildCoreToolLinkRegistry } from './tool-link-handlers.js';
import { ToolResultBuffer } from '../tools/result-buffer.js';
import { sanitizeToolResult } from '../tools/injection-filter.js';
import type { GitManager } from '../evolution/git-manager.js';
import type { TurnRecorder } from '../rollback/turn-recorder.js';
import type { LoopHookBus } from './loop-hooks.js';
import { runAttributed } from '../kernel/security/index.js';
import * as sessionAllowlist from '../tools/session-allowlist.js';

/**
 * 工具执行上下文：执行器所需的全部依赖 + 可变状态访问器。
 * 由 AgentLoop.makeToolExecContext() 构造（每轮调用取当前值）。
 */
/** 工具执行结果摘要（P2：afterToolExecute 区分真实成败） */
import { analyzeReferences, type ReferenceAnalysisCapability } from '../tools/reference-analysis.js';

export interface ToolExecOutcome {
  id: string;
  name: string;
  ok: boolean;
}

export interface ToolExecContext {
  outputHandler: OutputHandler | null;
  sessionDir: string;
  /** 当前回合号（安全门禁的 beforeToolExecute 载荷需要） */
  turn: number;
  /** 主循环钩子总线（inline 路径的安全门禁在此过，与批量路径同权） */
  loopHooks?: LoopHookBus;
  turnRecorder?: TurnRecorder | null;
  dependencyAnalyzer?: DependencyAnalyzer;
  /** 引用分析能力（Phase 6）：xref 挂载时经 stageServices 注入；缺省 → 用核心内置兜底 */
  referenceAnalysis?: ReferenceAnalysisCapability | null;
  gitManager: GitManager;
  conversationStore: ConversationStore;
  configCenter?: RuntimeConfigCenter;
  toolExecutor: ToolExecutor;
  toolRegistry: ToolRegistry;
  resultBuffer: ToolResultBuffer;
  abortController: AbortController | null;
  dangerousTools: Set<string>;
  allowlistTools: Set<string>;
  allowedCommands: Set<string>;
  loopGuard: LoopGuard;
  // ── 可变状态（loop 的私有字段，经访问器读写，避免共享裸字段）──
  getUnrestricted(): boolean;
  setUnrestricted(v: boolean): void;
  getPendingImpact(): string | null;
  setPendingImpact(v: string | null): void;
  /** 流内工具结果的暂存表（引用共享；loop 持有） */
  inlineToolResults: Map<string, { content: string; isError: boolean }>;
  // ── 验证证据账本（P1-B）：本轮是否发生修改 / 产生了多少验证证据 ──
  markMutation(): void;
  hadMutation(): boolean;
  addEvidence(): void;
  evidenceCount(): number;
  /**
   * 执行侧工具包对称校验（治本）：工具实际执行前的最终防线。
   * 组装侧（context 阶段）负责"不可见"，这里负责"不可执行"——
   * 即使模型幻觉/被诱导调用了激活包之外的工具，也在执行前拦截。
   * 返回 true = 允许执行；undefined（未注入）或返回 true = 放行。
   * 由 loop.makeToolExecContext 从 bundleRegistry 派生注入。
   */
  isToolAllowedByBundle?: (name: string) => boolean;
}

/** Check if a bash command matches any allowedCommands glob pattern */
export function checkCommandAllowed(ctx: ToolExecContext, command?: string): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  for (const pattern of ctx.allowedCommands) {
    if (trimmed === pattern) return true;
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (re.test(trimmed)) return true;
    }
  }
  return false;
}

/**
 * 内部方法：执行工具调用并写回结果。
 * 返回每个调用的真实结果摘要（{id,name,ok}），供 afterToolExecute 区分成败（P2）。
 */
export async function runToolDispatch(ctx: ToolExecContext, toolCalls: ToolCall[]): Promise<ToolExecOutcome[]> {
  const outcomes: ToolExecOutcome[] = [];
  const permittedCalls: ToolCall[] = [];

  // ── 安全门禁（批量路径）：消费 beforeToolExecute 拦截器的过滤结果 ──
  // 旧实现经 stages/tools.ts emit 丢弃返回值，拦截器（如 permission-chain）
  // 的剔除从不生效；现改为在此消费，被剔除的调用写回明确的 denied 结果。
  let effectiveCalls = toolCalls;
  if (ctx.loopHooks?.has('beforeToolExecute')) {
    const gated = await ctx.loopHooks.run(
      'beforeToolExecute',
      { turn: ctx.turn, calls: toolCalls },
      async (p) => p,
    );
    const gatedIds = new Set(gated.calls.map((c) => c.id));
    const dropped = toolCalls.filter((tc) => !gatedIds.has(tc.id));
    for (const tc of dropped) {
      outcomes.push({ id: tc.id, name: tc.name, ok: false });
      const blockedMessage: Message = {
        role: 'user',
        content: {
          type: 'tool_result',
          tool_use_id: tc.id,
          content: 'Tool call blocked by beforeToolExecute hook (security gate)',
          is_error: true,
        } as ToolResultContent,
      };
      await ctx.conversationStore.append(ctx.sessionDir, blockedMessage);
      ctx.outputHandler?.onToolResult?.(`Blocked by security gate: ${tc.name}`, true, tc.id);
    }
    effectiveCalls = gated.calls;
  }

  // ── 执行侧工具包对称校验（治本）：激活包之外的工具，即使被模型调用也拦截 ──
  // 组装侧（context 阶段）让包外工具对 LLM 不可见；这里补上执行侧最终防线——
  // 只要工具不在激活包内（isToolAllowedByBundle 返回 false），一律不执行。
  if (ctx.isToolAllowedByBundle) {
    const allowedCalls: ToolCall[] = [];
    for (const tc of effectiveCalls) {
      if (ctx.isToolAllowedByBundle(tc.name)) {
        allowedCalls.push(tc);
      } else {
        outcomes.push({ id: tc.id, name: tc.name, ok: false });
        const blockedMsg: Message = {
          role: 'user',
          content: {
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `Tool "${tc.name}" is not in the active tool bundle. Enable the bundle that contains it (or switch to all mode) before calling it.`,
            is_error: true,
          } as ToolResultContent,
        };
        await ctx.conversationStore.append(ctx.sessionDir, blockedMsg);
        ctx.outputHandler?.onToolResult?.(`Blocked by tool bundle: ${tc.name}`, true, tc.id);
      }
    }
    effectiveCalls = allowedCalls;
  }

  for (const tc of effectiveCalls) {
    if (ctx.dangerousTools.has(tc.name) && ctx.outputHandler?.onPermissionRequest) {
      // Step 0: AOR — unrestricted mode, skip all permissions
      if (ctx.getUnrestricted()) {
        permittedCalls.push(tc);
        continue;
      }
      // Step 1: check session allowlist
      if (ctx.allowlistTools.has(tc.name)) {
        permittedCalls.push(tc);
        continue;
      }
      // Step 2: check allowedCommands glob (bash only)
      if (tc.name === 'bash' && checkCommandAllowed(ctx, tc.input?.command as string)) {
        permittedCalls.push(tc);
        continue;
      }
      // Step 3: pop permission
      const result = await ctx.outputHandler.onPermissionRequest(tc.name, tc.input);
      if (result === 'no') {
        // Permission denied — add error result directly to conversation
        outcomes.push({ id: tc.id, name: tc.name, ok: false });
        const deniedMessage: Message = {
          role: 'user',
          content: {
            type: 'tool_result',
            tool_use_id: tc.id,
            content: 'Permission denied by user',
            is_error: true,
          } as ToolResultContent,
        };
        await ctx.conversationStore.append(ctx.sessionDir, deniedMessage);
        ctx.outputHandler?.onToolResult?.('Permission denied by user', true, tc.id);
        continue;
      }
      if (result === 'aor') {
        ctx.setUnrestricted(true);
        ctx.outputHandler?.onStatus?.('AOR mode enabled — all future tool calls unrestricted', 'warn');
      }
      // 'yes', 'always', or 'aor' — allow this call
      if (result === 'always') {
        ctx.allowlistTools.add(tc.name);
        sessionAllowlist.addTool(ctx.sessionDir, tc.name).catch(() => {});
        if (tc.name === 'bash' && tc.input?.command) {
          sessionAllowlist.addCommand(ctx.sessionDir, tc.input.command as string).catch(() => {});
        }
      }
    }
    permittedCalls.push(tc);
  }

  if (permittedCalls.length === 0) return outcomes;

  // LoopGuard tool check: detect and suppress repeated identical tool calls
  const stormEnabled = ctx.configCenter
    ? (ctx.configCenter.get('repair.storm.enabled') as boolean)
    : true;

  let executableCalls: ToolCall[] = permittedCalls;

  if (stormEnabled !== false) {
    const { suppressed, reflections } = ctx.loopGuard.checkToolCalls(permittedCalls);
    const suppressedCalls: ToolCall[] = [];
    executableCalls = [];

    for (const tc of permittedCalls) {
      if (suppressed.has(tc.id)) {
        suppressedCalls.push(tc);
      } else {
        executableCalls.push(tc);
      }
    }

    // Inject reflection for suppressed calls
    for (const tc of suppressedCalls) {
      const reflectionText = reflections.get(tc.id) ?? ToolGuard.reflectionPrompt(tc);
      const reflectionMsg: Message = {
        role: 'user',
        content: {
          type: 'tool_result',
          tool_use_id: tc.id,
          content: `[Storm suppressed] ${reflectionText}`,
          is_error: true,
        } as ToolResultContent,
      };
      await ctx.conversationStore.append(ctx.sessionDir, reflectionMsg);
      ctx.outputHandler?.onToolResult?.(`Storm suppressed: ${tc.name}`, true, tc.id);
      outcomes.push({ id: tc.id, name: tc.name, ok: false });
    }
  }

  if (executableCalls.length === 0) return outcomes;

  // ── 验证证据账本：本轮是否发生修改（P1-B；turn-end 证据门消费） ──
  for (const tc of executableCalls) {
    if (isMutatingTool(tc.name)) ctx.markMutation();
  }

  // ── 回合回滚：记录写操作的前置状态 ──
  if (ctx.turnRecorder) {
    const projectDir = ctx.gitManager.getRepoPath();
    for (const tc of executableCalls) {
      if (isWriteTool(tc.name)) {
        const filePath = tc.input.file_path as string;
        if (filePath) {
          ctx.turnRecorder.recordPreState(path.resolve(projectDir, filePath));
        }
      }
    }
  }

  // ── 同文件写冲突检测 ──
  // 同一批里两个写工具命中同一文件时，并行执行会让两者各自读到旧内容、
  // 各自写入：先完成的修改被后完成的整体覆盖，且两者都返回 success ——
  // 模型完全看不到丢失。同时 recordPreState 会被第二次调用覆盖掉回滚锚点。
  // 冲突调用改为顺序执行（前一次写入对后一次可见）。
  const conflicting = findWriteConflicts(executableCalls, ctx.gitManager.getRepoPath());

  // 执行：无冲突的并行，有冲突的顺序；结果按 executableCalls 原序回填
  const results: ToolResult[] = new Array(executableCalls.length);
  const parallelSlots: number[] = [];
  executableCalls.forEach((_tc, i) => {
    if (!conflicting.has(i)) parallelSlots.push(i);
  });

  if (parallelSlots.length > 0) {
    const parallelResults = await ctx.toolExecutor.executeParallel(
      parallelSlots.map((i) => executableCalls[i]),
    );
    parallelResults.forEach((r, k) => {
      results[parallelSlots[k]] = r;
    });
  }

  for (const i of [...conflicting].sort((a, b) => a - b)) {
    results[i] = await ctx.toolExecutor.execute(executableCalls[i]);
  }

  // ── 回合回滚：记录 bash 命令 ──
  if (ctx.turnRecorder) {
    for (const tc of executableCalls) {
      if (tc.name === 'bash') {
        const cmd = tc.input.command as string;
        if (cmd) ctx.turnRecorder.recordCommand(cmd);
      }
    }
  }

  // 影响面分析：检查是否有 edit 或 write 工具被调用
  if (ctx.dependencyAnalyzer && permittedCalls.some(tc => tc.name === 'edit' || tc.name === 'write')) {
    const editedFiles = permittedCalls
      .filter(tc => tc.name === 'edit' || tc.name === 'write')
      .map(tc => tc.input.file_path as string)
      .filter(Boolean);
    if (editedFiles.length > 0) {
      // 先增量更新依赖图
      await ctx.dependencyAnalyzer.incrementalUpdate(editedFiles, ctx.gitManager);
      // 再查询影响面
      const impacts = editedFiles.map(f => ctx.dependencyAnalyzer!.getImpact(f));
      const impactLines = impacts
        .filter(i => i.allImpacts.length > 0)
        .map(i => `[Dependency Impact] ${i.sourceFile} → affects: ${i.allImpacts.join(', ')}`);
      if (impactLines.length > 0) {
        ctx.setPendingImpact(impactLines.join('\n'));
      }
    }
  }

  // 将工具结果追加到 conversation（过大的结果先缓冲到磁盘）
  // 但读缓冲文件本身的结果不再二次缓冲（避免递归缓冲）
  const bufferDir = ctx.resultBuffer.getBufferDir();
  for (const result of results) {
    const call = executableCalls.find(c => c.id === result.tool_use_id);

    // Flow 工具结果不记入历史 — 状态由 Zone 5 注入体现
    if (call?.name && isFlowTool(call.name)) continue;

    // 按**清单**驱动：处理器与顺序来自 ~/.agent/tool-links.json（缺省 = 出厂默认 = 迁移前行为）
    const linkNotes = await runDeclaredLinks(ctx, call);

    const withNotes = [result.content, linkNotes].filter((x) => x).join('\n\n');
    const sanitized = sanitizeToolResult(withNotes);
    const skipBuffer = call?.name === 'read' && typeof call.input.file_path === 'string' &&
      call.input.file_path.startsWith(bufferDir);
    const content = skipBuffer ? sanitized : ctx.resultBuffer.maybeBuffer(sanitized, result.tool_use_id);
    const toolResultMessage: Message = {
      role: 'user',
      content: {
        type: 'tool_result',
        tool_use_id: result.tool_use_id,
        content,
        is_error: result.is_error,
      } as ToolResultContent,
    };
    await ctx.conversationStore.append(ctx.sessionDir, toolResultMessage);

    // 显示工具结果摘要
    ctx.outputHandler?.onToolResult?.(content, result.is_error ?? false, result.tool_use_id);
    // diff 通知：**键用 filePath**（原先用 tool_use_id 查按 filePath 索引的账本 ⇒ 永不命中 ⇒
    // 通知从未触发 —— 即缺陷票③）。此处 peek 读、随后消费一次：既修好通知，又不饿死引用自检。
    const { peekDiff: peekD2, popDiff: popD2 } = await import('../tools/diff-channel.js');
    const diffFile = call && typeof call.input.file_path === 'string' ? call.input.file_path : undefined;
    const diffData = diffFile ? peekD2(diffFile) : undefined;
    if (diffData && diffFile) {
      ctx.outputHandler?.onDiff?.(result.tool_use_id, diffData.filePath, diffData.lines);
      popD2(diffFile);
    }
    // 真实结果摘要（P2：区分成败）
    outcomes.push({ id: result.tool_use_id, name: call?.name ?? result.tool_use_id, ok: !(result.is_error ?? false) });
  }

  return outcomes;
}

/**
 * Execute a single tool inline during the SSE stream.
 * Stores the result for later conversation append; fires onToolResult for real-time feedback.
 */
export async function runToolInline(
  ctx: ToolExecContext,
  id: string,
  name: string,
  input: Record<string, unknown>,
): Promise<void> {
  const tool = ctx.toolRegistry.get(name);
  if (!tool) {
    const errContent = `Unknown tool: ${name}`;
    ctx.outputHandler?.onToolResult?.(errContent, true, id);
    ctx.inlineToolResults.set(id, { content: errContent, isError: true });
    appendEvent(ctx.sessionDir, {
      type: 'tool_result',
      tool_use_id: id,
      name,
      content: errContent,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    return;
  }

  // ── 执行侧工具包对称校验（治本）：流内路径与批量路径同权拦截 ──
  if (ctx.isToolAllowedByBundle && !ctx.isToolAllowedByBundle(name)) {
    const errContent = `Tool "${name}" is not in the active tool bundle. Enable the bundle that contains it (or switch to all mode) before calling it.`;
    ctx.outputHandler?.onToolResult?.(errContent, true, id);
    ctx.inlineToolResults.set(id, { content: errContent, isError: true });
    appendEvent(ctx.sessionDir, {
      type: 'tool_result',
      tool_use_id: id,
      name,
      content: errContent,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    return;
  }

  // Permission check for dangerous tools
  if (ctx.dangerousTools.has(name) && ctx.outputHandler?.onPermissionRequest) {
    // Step 0: AOR — unrestricted mode, skip all permissions
    if (!ctx.getUnrestricted()) {
      // Step 1: check session allowlist
      if (ctx.allowlistTools.has(name)) {
        // allowed, proceed
      } else if (name === 'bash' && checkCommandAllowed(ctx, input?.command as string)) {
        // Step 2: check allowedCommands glob
        // allowed, proceed
      } else {
        // Step 3: pop permission
        const result = await ctx.outputHandler.onPermissionRequest(name, input);
        if (result === 'no') {
          const deniedMsg = 'Permission denied by user';
          ctx.outputHandler?.onToolResult?.(deniedMsg, true, id);
          ctx.inlineToolResults.set(id, { content: deniedMsg, isError: true });
          appendEvent(ctx.sessionDir, {
            type: 'tool_result',
            tool_use_id: id,
            name,
            content: deniedMsg,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
          return;
        }
        if (result === 'aor') {
          ctx.setUnrestricted(true);
          ctx.outputHandler?.onStatus?.('AOR mode enabled — all future tool calls unrestricted', 'warn');
        }
        if (result === 'always') {
          ctx.allowlistTools.add(name);
          sessionAllowlist.addTool(ctx.sessionDir, name).catch(() => {});
          if (name === 'bash' && input?.command) {
            sessionAllowlist.addCommand(ctx.sessionDir, input.command as string).catch(() => {});
          }
        }
      }
    }
  }

  // ── 安全门禁（inline 路径）：与批量路径同权消费 beforeToolExecute 拦截器 ──
  if (ctx.loopHooks?.has('beforeToolExecute')) {
    const gated = await ctx.loopHooks.run(
      'beforeToolExecute',
      { turn: ctx.turn, calls: [{ id, name, input }] },
      async (p) => p,
    );
    if (gated.calls.length === 0) {
      const blockedMsg = 'Tool call blocked by beforeToolExecute hook (security gate)';
      ctx.outputHandler?.onToolResult?.(blockedMsg, true, id);
      ctx.inlineToolResults.set(id, { content: blockedMsg, isError: true });
      appendEvent(ctx.sessionDir, {
        type: 'tool_result',
        tool_use_id: id,
        name,
        content: blockedMsg,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      return;
    }
  }

  // LoopGuard tool check for inline execution
  const stormEnabled = ctx.configCenter
    ? (ctx.configCenter.get('repair.storm.enabled') as boolean)
    : true;

  const STORM_EXEMPT = ['read', 'glob', 'grep'];
  if (stormEnabled !== false && !isMutating(name) && !STORM_EXEMPT.includes(name) && !isFlowTool(name)) {
    const { suppressed } = ctx.loopGuard.checkToolCalls([{ id, name, input }]);
    if (suppressed.has(id)) {
      const stormMsg = `[Storm suppressed] ${ToolGuard.reflectionPrompt({ id, name, input })}`;
      ctx.outputHandler?.onToolResult?.(stormMsg, true, id);
      ctx.inlineToolResults.set(id, { content: stormMsg, isError: true });
      appendEvent(ctx.sessionDir, {
        type: 'tool_result',
        tool_use_id: id,
        name,
        content: stormMsg,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      return;
    }
  }

  // ── 回合回滚：记录写操作前置状态 ──
  if (ctx.turnRecorder) {
    if (isWriteTool(name)) {
      const filePath = input.file_path as string;
      if (filePath) {
        ctx.turnRecorder.recordPreState(path.resolve(ctx.gitManager.getRepoPath(), filePath));
      }
    } else if (name === 'bash') {
      const cmd = input.command as string;
      if (cmd) ctx.turnRecorder.recordCommand(cmd);
    }
  }

  // ── 验证证据账本：inline 路径同样记账（P1-B） ──
  if (isMutatingTool(name)) ctx.markMutation();

  // Execute tool directly（安全内核归因：与批量路径同权）
  try {
    const toolSource = (tool as { source?: string }).source;
    const rawResult = await runAttributed(
      { kind: 'tool', name: `${toolSource ?? 'core'}:${name}` },
      () => tool.execute(input, ctx.abortController?.signal ?? undefined),
    );
    // 读缓冲文件本身的结果不再二次缓冲（避免递归缓冲）
    const isBufferedRead = name === 'read' && typeof (input as Record<string, unknown>).file_path === 'string' &&
      ((input as Record<string, unknown>).file_path as string).startsWith(ctx.resultBuffer.getBufferDir());
    const result = isBufferedRead
      ? sanitizeToolResult(rawResult)
      : ctx.resultBuffer.maybeBuffer(sanitizeToolResult(rawResult), name);
    ctx.outputHandler?.onToolResult?.(result, false, id);
    // diff 通知（edit/write/multi_edit 按 filePath 写入）—— **读而不删**：
    // 引用自检（flushInlineResults 内）还要用同一条事实；消费在 flushInlineResults 末尾统一做。
    if (name === 'edit' || name === 'write' || name === 'multi_edit') {
      const { peekDiff: peekD } = await import('../tools/diff-channel.js');
      const fp = (input as Record<string, unknown>)?.file_path as string;
      if (fp) {
        const diffData = peekD(fp);
        if (diffData) ctx.outputHandler?.onDiff?.(id, diffData.filePath, diffData.lines);
      }
    }
    ctx.inlineToolResults.set(id, { content: result, isError: false });
    appendEvent(ctx.sessionDir, {
      type: 'tool_result',
      tool_use_id: id,
      name,
      content: result.slice(0, 1000), // truncate long results in events log
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.outputHandler?.onToolResult?.(`Error: ${errMsg}`, true, id);
    ctx.inlineToolResults.set(id, { content: `Error: ${errMsg}`, isError: true });
    appendEvent(ctx.sessionDir, {
      type: 'tool_result',
      tool_use_id: id,
      name,
      content: `Error: ${errMsg}`,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  }
}

/**
 * 找出一批工具调用中「写同一文件」的冲突，返回**需要串行执行的下标集合**（保留最早的那个并行）。
 * 归一化到绝对路径并忽略大小写，避免 `./a.ts` 与 `a.ts`、`A.ts` 被判成不同文件。
 */
function findWriteConflicts(calls: ToolCall[], projectDir: string): Set<number> {
  const seen = new Map<string, number>();
  const conflicts = new Set<number>();
  calls.forEach((tc, i) => {
    if (!isWriteTool(tc.name)) return;
    const raw = tc.input?.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return;
    const key = path.resolve(projectDir, raw).toLowerCase();
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, i);
    } else {
      conflicts.add(i);
    }
  });
  return conflicts;
}

/**
 * Flush inline tool results to the conversation store and run dependency analysis.
 * Called after the assistant message has been appended to maintain correct message ordering.
 */
/**
 * 引用自检注记（Phase 6 核心消费者）—— **两条工具执行路径共用这一份实现**。
 *
 * 为什么必须有这份助手（P0 教训，2026-09-19）：消费者原先只内联在 `executeTools` 的结果循环里 ✗，
 * 而 inline 路径（`flushInlineResults`）**完全不经它** ⇒ 真实 provider 多数在流内发 TOOL_USE
 * （`llm.ts` 的 executeSingleInline）⇒ **功能在生产里多半不触发**。端到端实测当场抓到。
 *
 * 为何不搬到 `afterToolExecute` 汇合点：汇合点（stages/tools.ts）在结果**已 append 之后** ✗，
 * 那时无法再追加进 tool_result（只能改成"下轮 pending 注记"，语义会变）。故取"一处实现 + 两处调用"，
 * 两处同在 loop-tools.ts、相邻函数 ⇒ 漂移风险远低于"两份实现"（那正是"内联副本"的老坑）。
 *
 * 三个不变的设计要点：① 放核心（兜底与插件有无无关 ✓ 子代理自动覆盖 ✓）；
 * ② 输入取**结构事实账本**（diff-channel 的 before/after）+ 工具入参，不反推（磁盘上已是新内容）；
 * ③ 任何异常都返回空串 —— 自检失败绝不影响工具返回值。
 */
/**
 * 按**清单**驱动联动（第三圈的核心入口）—— 两条执行路径共用这一份。
 *
 * 事件名取 `afterToolExecute:<工具名>`，处理器与**顺序**全部来自
 * `~/.agent/tool-links.json`（没有该文件 ⇒ 出厂默认 = 迁移前的行为）。
 * 因此"改关系"不再需要改代码：清单里删一行 = 断线，加一行 = 接线（诉求④）。
 *
 * 为什么在这里（而不是各处直接调处理器）：两件事都必须**只有一份实现** ——
 *   ① 事件名的拼法（将来若加"批量级事件"也只改这里）；
 *   ② **失败隔离**（三律③）：任一处理器抛错都不得影响工具结果，故 try/catch 收在这一层。
 * 今晚的 P0 教训也在这一句里：inline 与批量两条路径**必须都经过这里**，
 * 否则"功能只在其中一条路径生效"这种缺陷单测看不出来（当时正是端到端实测才抓到的）。
 */
async function runDeclaredLinks(ctx: ToolExecContext, call: ToolCall | undefined): Promise<string> {
  if (!call) return '';
  const event = `afterToolExecute:${call.name}`;
  const declared = resolveToolLinks(getCurrentToolLinks(), buildCoreToolLinkRegistry(), event);
  const notes: string[] = [];
  for (const { handler } of declared) {
    try {
      const out = await handler.run({
        event,
        toolName: call.name,
        // 调用方上下文：清单模块只声明 unknown（保持 supervisor 层干净），
        // 形状由 orchestrator/tool-link-handlers.ts 的 CoreHandlerPayload 约定
        payload: {
          input: call.input,
          capability: ctx.referenceAnalysis,
          effects: { addEvidence: () => ctx.addEvidence() },
        },
      });
      if (out) notes.push(out);
    } catch {
      // 处理器失败不影响工具结果（三律③：订阅者失败不得影响宿主）
    }
  }
  return notes.join('\n\n');
}

export async function flushInlineResults(ctx: ToolExecContext, toolCalls: ToolCall[]): Promise<ToolExecOutcome[]> {
  const outcomes: ToolExecOutcome[] = [];
  // Dependency impact analysis (same logic as runToolDispatch)
  if (ctx.dependencyAnalyzer && toolCalls.some(tc => tc.name === 'edit' || tc.name === 'write')) {
    const editedFiles = toolCalls
      .filter(tc => tc.name === 'edit' || tc.name === 'write')
      .map(tc => tc.input.file_path as string)
      .filter(Boolean);
    if (editedFiles.length > 0) {
      await ctx.dependencyAnalyzer.incrementalUpdate(editedFiles, ctx.gitManager);
      const impacts = editedFiles.map(f => ctx.dependencyAnalyzer!.getImpact(f));
      const impactLines = impacts
        .filter(i => i.allImpacts.length > 0)
        .map(i => `[Dependency Impact] ${i.sourceFile} -> affects: ${i.allImpacts.join(', ')}`);
      if (impactLines.length > 0) {
        ctx.setPendingImpact(impactLines.join('\n'));
      }
    }
  }

  // Append stored inline results to conversation
  for (const tc of toolCalls) {
    // Flow 工具结果不记入历史 — 状态由 Zone 5 注入体现
    if (isFlowTool(tc.name)) continue;

    const stored = ctx.inlineToolResults.get(tc.id);
    if (!stored) {
      // Tool wasn't executed inline (e.g., filtered out) — skip
      continue;
    }
    // 真实结果摘要（P2：区分成败）
    outcomes.push({ id: tc.id, name: tc.name, ok: !stored.isError });
    // ── 引用自检（与批量路径**同一份实现**，见 referenceNoteFor）──
    // P0 修复点：inline 是真实 provider 的常态路径，此前完全不经消费者。
    // 按清单驱动（与批量路径**同一套**：见 runDeclaredLinks 的说明）
    const linkNotes = await runDeclaredLinks(ctx, tc);
    const toolResultMessage: Message = {
      role: 'user',
      content: {
        type: 'tool_result',
        tool_use_id: tc.id,
        content: [stored.content, linkNotes].filter((x) => x).join('\n\n'),
        is_error: stored.isError,
      } as ToolResultContent,
    };
    await ctx.conversationStore.append(ctx.sessionDir, toolResultMessage);

    // **唯一消费点（本路径末）**：上面的 UI 通知与引用自检都只 peek（不删），故在此显式消费一次。
    // 谁都不吃亏、也不留残留（多工具写同一文件时各自消费自己的键）。
    if (isWriteTool(tc.name)) {
      const fp = tc.input?.file_path;
      if (typeof fp === 'string') {
        const { popDiff: popOnce } = await import('../tools/diff-channel.js');
        popOnce(fp);
      }
    }
  }
  return outcomes;
}
