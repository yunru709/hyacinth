// ============================================================
// companion-filter — 陪伴模式历史文本化/工具轮过滤（D2 收敛）
// ============================================================
// 从 context/precision/companion.ts 抽出（D2 消灭 ComposeStrategy 旧轨时，
// CompanionStrategy 类随旧轨删除；materializeExpressions / filterToolRounds
// 是陪伴模式活功能，由 input 阶段与 CompanionRouter.filterHistory 消费，
// 迁移至此独立文件）。
// ============================================================

import type { Message, ToolUseContent, ToolResultContent } from '../types.js';

/** 陪伴模式下的工具名 — 对话文本中出现即触发过滤 */
const COMPANION_TOOL_NAMES = [
  'companion_mode', 'reset_companion_session',
  'add_task', 'list_tasks', 'remove_task', 'toggle_task',
  'read', 'write', 'edit',
];

/** 工具相关关键词 — 只在 assistant 提到"能用/可用/有哪些"工具时触发 */
const TOOL_KEYWORDS = [
  '有哪些工具', '能用的工具', '可用工具', '工具列表',
  '命令执行', 'bash', 'powershell', '终端命令',
];

/**
 * materializeExpressions — 把 companion_say 表达轮次"文本化"。
 *
 * [tool_use companion_say + tool_result] → 一条普通 assistant 文本
 * （渲染格式：[动作]（心声）台词）。上下文组装与压缩输入统一走这里：
 *   - 压缩器/摘要器看到自然文本，台词不因"工具细节"被摘要丢弃（防失忆）
 *   - 模型看到纯角色扮演历史（比 tool JSON 更沉浸）
 *   - 存储层（jsonl）保持完整审计记录，非破坏性
 */
export function materializeExpressions(history: Message[]): Message[] {
  // 1. 收集表达工具的 id → 渲染文本
  const sayRenders = new Map<string, string>();
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const b of blocks) {
      if (b.type === 'tool_use' && (b as ToolUseContent).name === 'companion_say') {
        const input = ((b as ToolUseContent).input ?? {}) as {
          text?: string;
          think?: string;
          action?: string;
        };
        const parts: string[] = [];
        if (input.action) parts.push(`[${input.action}]`);
        if (input.think) parts.push(`（${input.think}）`);
        if (input.text) parts.push(input.text);
        sayRenders.set((b as ToolUseContent).id, parts.join(''));
      }
    }
  }
  if (sayRenders.size === 0) return history;

  // 2. assistant 消息：摘除表达 tool_use 块，渲染文本并入同一消息
  //    user 消息：摘除对应 tool_result 块（纯表达结果的消息整体移除，防孤儿）
  const out: Message[] = [];
  for (const msg of history) {
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];

    if (msg.role === 'assistant') {
      const hasSay = blocks.some(
        (b) => b.type === 'tool_use' && sayRenders.has((b as ToolUseContent).id),
      );
      if (!hasSay) {
        out.push(msg);
        continue;
      }
      const newBlocks: Array<Record<string, unknown>> = [];
      const renders: string[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_use' && sayRenders.has((b as ToolUseContent).id)) {
          renders.push(sayRenders.get((b as ToolUseContent).id)!);
          continue;
        }
        newBlocks.push(b as unknown as Record<string, unknown>);
      }
      if (renders.length > 0) {
        newBlocks.push({ type: 'text', text: renders.join('\n') });
      }
      if (newBlocks.length === 0) continue;
      out.push({ ...msg, content: newBlocks } as unknown as Message);
      continue;
    }

    if (msg.role === 'user') {
      const newBlocks = blocks.filter((b) => {
        if ((b as { type?: string }).type !== 'tool_result') return true;
        return !sayRenders.has((b as ToolResultContent).tool_use_id);
      });
      if (newBlocks.length === 0) continue;
      if (newBlocks.length === blocks.length) {
        out.push(msg);
        continue;
      }
      out.push({ ...msg, content: newBlocks } as unknown as Message);
      continue;
    }

    out.push(msg);
  }
  return out;
}

/**
 * 从历史消息中移除所有包含工具调用或工具相关文本的完整回合。
 *
 * 检测两类情况：
 *   A. assistant 消息中包含 tool_use 块（实际调用了工具）
 *   B. assistant 的文本中出现了工具名或关键词（"你有哪些工具可用？"→ 列工具名）
 *
 * 两种情况都会移除整轮：用户消息 + assistant 消息 + tool_result + 跟进文本。
 */
export function filterToolRounds(history: Message[]): Message[] {
  // 表达轮次先文本化（文本天然豁免后续工具清洗）
  history = materializeExpressions(history);
  const dirtyIndices = new Set<number>();
  const allToolIds = new Set<string>();

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;

    const contents = Array.isArray(msg.content) ? msg.content : [msg.content];

    // A. 检测 tool_use（companion_say 是表达工具，其轮次保留——不视为"元操作"痕迹；
    //    但混合轮（表达+其他工具）仍整轮清洗，此时表达的工具结果一并移除，防孤儿 tool_result）
    const hasNonSayToolUse = contents.some(
      (b) => b.type === 'tool_use' && (b as ToolUseContent).name !== 'companion_say',
    );
    for (const block of contents) {
      if (block.type !== 'tool_use') continue;
      const toolName = (block as ToolUseContent).name;
      if (toolName === 'companion_say' && !hasNonSayToolUse) continue;
      dirtyIndices.add(i);
      allToolIds.add((block as ToolUseContent).id);
    }

    // B. 检测文本中的工具名/关键词
    if (!dirtyIndices.has(i)) {
      for (const block of contents) {
        if (block.type === 'text') {
          const text = (block as { text: string }).text;
          if (containsToolContent(text)) {
            dirtyIndices.add(i);
            break;
          }
        }
      }
    }
  }

  // 也检测 user 消息文本中是否包含工具名（用户问"你有哪些工具"）
  for (let i = 0; i < history.length; i++) {
    if (dirtyIndices.has(i)) continue;
    const msg = history[i];
    if (msg.role !== 'user') continue;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text && containsToolContent(text)) {
      // 用户问了工具相关 → 标记下一条 assistant 为 dirty
      for (let j = i + 1; j < history.length; j++) {
        if (history[j].role === 'assistant') {
          dirtyIndices.add(j);
          break;
        }
        if (history[j].role === 'user') break;
      }
    }
  }

  if (dirtyIndices.size === 0) return history;

  const removeIndices = new Set<number>();

  // 移除 dirty assistant + 前一条 user
  for (const idx of dirtyIndices) {
    removeIndices.add(idx);
    if (idx > 0 && history[idx - 1].role === 'user') {
      removeIndices.add(idx - 1);
    }
  }

  // 移除对应的 tool_result
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of contents) {
      if (
        block.type === 'tool_result' &&
        allToolIds.has((block as ToolResultContent).tool_use_id)
      ) {
        removeIndices.add(i);
      }
    }
  }

  // 移除跟进纯文本
  const sortedDirty = [...dirtyIndices].sort((a, b) => a - b);
  for (const idx of sortedDirty) {
    let next = idx + 1;
    while (next < history.length) {
      if (removeIndices.has(next)) { next++; continue; }
      if (history[next].role === 'assistant') {
        const raw = history[next].content;
        const blocks = Array.isArray(raw) ? raw : [{ type: 'text' }];
        if (blocks.every((c: unknown) => (c as { type: string }).type === 'text')) {
          removeIndices.add(next);
          next++;
          continue;
        }
      }
      break;
    }
  }

  return history.filter((_, i) => !removeIndices.has(i));
}

function containsToolContent(text: string): boolean {
  const lower = text.toLowerCase();
  for (const name of COMPANION_TOOL_NAMES) {
    if (lower.includes(name)) return true;
  }
  for (const kw of TOOL_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  return false;
}
