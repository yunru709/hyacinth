/**
 * 通用工具函数 — 各模块共用的零依赖 helper。
 *
 * 提取自 dependency/analyzer.ts、memory/session.ts、gateway/cli.ts 中的重复实现。
 * 消息判定类（hasTextContent / hasToolUseContent / isSameTextMessage）自 loop.ts 下沉，
 * 供 orchestrator/stages/* 阶段模块复用（避免阶段模块与 loop 循环依赖）。
 */

import type { Message } from '../types.js';

/** 判断消息是否包含文本内容（而非纯 tool_result） */
export function hasTextContent(content: Message['content']): boolean {
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    return content.some((c) => c.type === 'text');
  }
  return content.type === 'text';
}

/** 判断消息是否包含 tool_use 内容 */
export function hasToolUseContent(content: Message['content']): boolean {
  if (typeof content === 'string') return false;
  if (Array.isArray(content)) {
    return content.some((c) => c.type === 'tool_use');
  }
  return content.type === 'tool_use';
}

/** 判断两条消息是否具有相同的 role 和 text content（按块序列比对） */
export function isSameTextMessage(a: Message, b: Message): boolean {
  if (a.role !== b.role) return false;
  const aContents = Array.isArray(a.content) ? a.content : [a.content];
  const bContents = Array.isArray(b.content) ? b.content : [b.content];
  if (aContents.length !== bContents.length) return false;
  for (let i = 0; i < aContents.length; i++) {
    const ac = aContents[i];
    const bc = bContents[i];
    if (ac.type !== bc.type) return false;
    if (ac.type === 'text') {
      if ((ac as any).text !== (bc as any).text) return false;
    } else if (ac.type === 'image') {
      const aSrc = (ac as any).source;
      const bSrc = (bc as any).source;
      if (aSrc?.type !== bSrc?.type) return false;
      if (aSrc?.type === 'base64' && aSrc?.data !== bSrc?.data) return false;
      if (aSrc?.type === 'url' && aSrc?.url !== bSrc?.url) return false;
    } else {
      // For other types (tool_use, tool_result, thinking), compare serialized
      if (JSON.stringify(ac) !== JSON.stringify(bc)) return false;
    }
  }
  return true;
}


/** 将工作目录路径归一化为项目标识（projectKey） */
export function toProjectKey(cwd: string): string {
  const normalized = cwd.replace(/[/\\]+/g, '-');
  return normalized.replace(/^[-]+|[-]+$/g, '').replace(/:/g, '');
}

/** 从消息 content 中提取文本（跳过 thinking/tool_use 等非文本块） */
export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text)
      .join('');
  }
  if (content && typeof content === 'object' && (content as Record<string, unknown>).type === 'text') {
    return (content as { text: string }).text;
  }
  return '';
}

/** 日期格式化为 YYYY-MM-DD */
export function formatDate(date?: Date): string {
  const d = date ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 格式化为 YYYY-MM-DD HH:mm（缓存友好，分钟精度；自 loop.ts 下沉，context 阶段 compose 复用） */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d} ${h}:${min}`;
}

/** 从末尾累加消息，直到累计 token 数超过 budget，返回保护条数（至少 2；自 loop.ts 下沉） */
export function computeProtectCount(messages: Message[], tokenBudget: number): number {
  // 使用简化的 char/4 估算
  let tokens = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const rawContent = messages[i].content;
    const text: string = typeof rawContent === 'string'
      ? rawContent
      : JSON.stringify(rawContent);
    tokens += Math.ceil(text.length / 4) + 4; // +4 for role/overhead
    count++;
    if (tokens >= tokenBudget) break;
  }
  return Math.max(2, count); // 至少保护 2 条
}

/** 生成工具输入的摘要字符串（每条 key=截断值，80 字符截断；自 loop.ts 下沉，llm 阶段 onToolUse 复用） */
export function summarizeToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '{}';

  const parts = entries.map(([key, value]) => {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    const truncated = str.length > 80 ? str.slice(0, 77) + '...' : str;
    return `${key}=${truncated}`;
  });

  return parts.join(', ');
}
