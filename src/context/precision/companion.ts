import type { Message, ToolUseContent, ToolResultContent } from '../../types.js';
import type { Provider } from '../../provider/interface.js';
import type { ComposeStrategy, ComposeStrategyOptions } from './types.js';

/**
 * CompanionStrategy — 陪伴模式。
 *
 * 不做关键词分析、不截断历史。
 * filterHistory 移除所有包含工具调用或工具相关文本的回合，
 * 保持陪伴对话纯净——陪伴模式下不应夹杂任何"元操作"痕迹。
 */
export class CompanionStrategy implements ComposeStrategy {
  name = 'companion';

  prepareCompose(_personaDir: string | undefined): ComposeStrategyOptions {
    return { personaDir: undefined };
  }

  filterHistory(history: Message[]): Message[] {
    return filterToolRounds(history);
  }

  async analyzeTurn(_messages: Message[], _provider: Provider): Promise<void> {
    // 陪伴模式不需要关键词提取
  }
}

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
 * 从历史消息中移除所有包含工具调用或工具相关文本的完整回合。
 *
 * 检测两类情况：
 *   A. assistant 消息中包含 tool_use 块（实际调用了工具）
 *   B. assistant 的文本中出现了工具名或关键词（"你有哪些工具可用？"→ 列工具名）
 *
 * 两种情况都会移除整轮：用户消息 + assistant 消息 + tool_result + 跟进文本。
 */
export function filterToolRounds(history: Message[]): Message[] {
  const dirtyIndices = new Set<number>();
  const allToolIds = new Set<string>();

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;

    const contents = Array.isArray(msg.content) ? msg.content : [msg.content];

    // A. 检测 tool_use
    for (const block of contents) {
      if (block.type === 'tool_use') {
        dirtyIndices.add(i);
        allToolIds.add((block as ToolUseContent).id);
      }
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
