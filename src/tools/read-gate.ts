/**
 * read-gate — write / edit 的读取门控「拒绝响应」：把惩罚变成教学 + 给料
 *
 * 背景（2026-09-19 由真实语料驱动）：
 *   统计一条真实会话的 647 次工具调用，16 次可辩护失败里 **11 次**是同一个原因 ——
 *   `write` / `edit` 要求"先读过这个文件"，而这条要求（a）不在参数表里，调用前不可见，
 *   （b）门控状态是进程内的，重启即失忆。于是每次重启后改第一个文件必被拒一次，白扔一轮。
 *
 * 但门控本身**是对的**，不能拆：覆盖式写入 / 无锚点替换若在没读过时执行，会把没看到的
 * 内容静默写没（代价远高于浪费一轮）。所以这里改的是**拒绝的方式**，不是拒绝本身：
 *   拒绝时顺手把内容交出去 → 当轮就拿到所需上下文 → 下一轮直接成功（3 轮压到 2 轮）。
 *
 * ⚠️ 核心安全约束：**交出了多少，才允许往下走多少。**
 *
 *   | 操作 | 能否自校验？ | 交出什么即可放行 |
 *   |---|---|---|
 *   | `write` 整份覆盖 | 否（无锚点） | **只有交出全文** |
 *   | `edit` **行模式**（line_start，无锚点） | 否 | **只有交出全文**（等价于 write） |
 *   | `edit` **字符串模式**（old_string 唯一匹配） | **能** | 锚点上下文即可 |
 *   | `multi_edit` | 同字符串模式 | 锚点上下文即可 |
 *   | `insert` 按行插入 | —（只加行、不覆盖） | 不受本门控约束（仅工作区围栏） |
 *   | `read` 带 offset/limit 或 outline/symbol | — | **只算"部分见过"**：解锁锚定 edit，不解锁覆盖 |
 *
 * 依据：锚定替换只会改动 `old_string` 命中处；模型若在瞎猜，`old_string` 必然匹配不上，
 * 工具当场拒绝，损坏无从发生。而"行号"与"整份覆盖"都没有这个自校验锚点。
 */

import { recordFileRead, recordPartialRead } from './file-tracker.js';

/** 内联返回的最大字符数。留余量，避免整段结果被送进结果缓冲（那样就看不到内容了） */
export const INLINE_BUDGET = 12_000;

const HEAD_LINES = 40;
const TAIL_LINES = 20;
const EDIT_CONTEXT_LINES = 20;

type Reason = 'unread' | 'stale';
type Kind = 'write' | 'edit';

function refusalHead(kind: Kind, filePath: string, reason: Reason, lineCount: number, charCount: number): string[] {
  const verb = kind === 'write' ? 'overwrite' : 'edit';
  const head: string[] = [];
  if (reason === 'unread') {
    head.push(`Error: not read yet — refusing to ${verb} ${filePath}.`, '');
    head.push(
      `  rule: write/edit require this file to have been read first in this session — the gate`,
      `  exists to prevent edits anchored on guessed content.`,
    );
  } else {
    head.push(`Error: this file changed on disk since you read it — refusing to ${verb} ${filePath}.`, '');
    head.push('  (That check is a real safety signal, not a formality: your view of the file is stale.)');
  }
  head.push('', `Current content: ${lineCount} line(s), ${charCount} char(s).`);
  return head;
}

/** 无锚点操作（write / edit 行模式）的拒绝响应：够小交出全文并放行，否则只给头尾且**不放行** */
function refuseWithoutAnchor(filePath: string, content: string, reason: Reason, kind: Kind): string {
  const lines = content.split('\n');
  const head = refusalHead(kind, filePath, reason, lines.length, content.length);

  if (content.length <= INLINE_BUDGET) {
    recordFileRead(filePath); // 全文已交出 = 已读过 → 下一轮直接成功
    return [
      ...head, '',
      '--- BEGIN CURRENT CONTENT ---',
      content,
      '--- END CURRENT CONTENT ---',
      '',
      'You now have the FULL content, so this counts as having read it:',
      're-issue the same call and it will be applied.',
      '(If your change is local, prefer a string-mode `edit` — it is anchored on old_string',
      ' and does not require a full read.)',
    ].join('\n');
  }

  recordPartialRead(filePath); // 只给了片段 → 不放行
  return [
    ...head, '',
    `Too large to inline (budget ${INLINE_BUDGET} chars) — showing first ${HEAD_LINES} and last ${TAIL_LINES} lines.`,
    '', `--- FIRST ${HEAD_LINES} LINES ---`,
    lines.slice(0, HEAD_LINES).join('\n'),
    `--- LAST ${TAIL_LINES} LINES ---`,
    lines.slice(-TAIL_LINES).join('\n'),
    '',
    'This is only PART of the file, so the operation is STILL BLOCKED — deliberately:',
    'proceeding from a partial view would drop whatever you have not seen.',
    '→ To UNLOCK an overwrite you need a **whole-file read**: call `read` with no offset/limit.',
    '  (offset/limit or symbol/outline count as PARTIAL — they unlock anchored `edit`, not overwrite.)',
    '→ Or, if your change is local and anchored, use a string-mode `edit` — that is allowed now.',
  ].join('\n');
}

/** `write` 被门控拒绝 */
export function refuseWriteUnread(filePath: string, content: string, reason: Reason = 'unread'): string {
  return refuseWithoutAnchor(filePath, content, reason, 'write');
}

/**
 * `edit` 被门控拒绝。
 *   - 传了 `oldString`（字符串模式，可自校验）→ 交出锚点上下文 / 或指出"未命中"，
 *     并记 partial：下一轮即可生效。
 *   - 未传（行模式，无锚点）→ 与 `write` 同等严格：只有交出全文才放行。
 */
export function refuseEditUnread(
  filePath: string,
  content: string,
  oldString: string | undefined,
  reason: Reason = 'unread',
): string {
  if (!oldString) return refuseWithoutAnchor(filePath, content, reason, 'edit');

  const lines = content.split('\n');
  const head = refusalHead('edit', filePath, reason, lines.length, content.length);

  const occurrences: number[] = [];
  if (oldString.includes('\n')) {
    if (content.includes(oldString)) occurrences.push(0); // 跨行只报"命中"
  } else {
    for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(oldString)) occurrences.push(i + 1);
  }

  recordPartialRead(filePath); // 拿下锚点上下文即足够 → 下一轮放行

  if (occurrences.length === 1 && !oldString.includes('\n')) {
    const at = occurrences[0]!;
    const from = Math.max(1, at - EDIT_CONTEXT_LINES);
    const to = Math.min(lines.length, at + EDIT_CONTEXT_LINES);
    return [
      ...head, '',
      `Your old_string occurs at line ${at} (unique). Context lines ${from}-${to}:`, '',
      '--- CONTEXT ---',
      lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}→${l}`).join('\n'),
      '--- END CONTEXT ---', '',
      'You have the anchor context now, so re-issue the same edit and it will be applied.',
    ].join('\n');
  }

  if (occurrences.length === 1) {
    return [
      ...head, '',
      'Your old_string WAS found in the current content (multi-line match) — re-issue the same',
      'edit and it will be applied.',
    ].join('\n');
  }

  if (occurrences.length > 1) {
    return [
      ...head, '',
      `Your old_string appears at ${occurrences.length} lines (NOT unique): ${occurrences.slice(0, 12).join(', ')}`
        + (occurrences.length > 12 ? ` …(+${occurrences.length - 12})` : ''),
      'A lone-line anchor is ambiguous. → Re-issue with a longer, more distinctive old_string,',
      'or use replace_all=true if you truly mean all of them.',
    ].join('\n');
  }

  return [
    ...head, '',
    'Your old_string was NOT FOUND in the current content — so your assumption about this file',
    'is wrong (this is exactly the hallucinated-edit case the gate guards against).',
    '', `--- FIRST ${HEAD_LINES} LINES ---`,
    lines.slice(0, HEAD_LINES).join('\n'),
    '--- END ---', '',
    '→ Re-read the file (offset/limit or symbol), then edit against what is actually there.',
  ].join('\n');
}
