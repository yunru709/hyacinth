/**
 * 通用工具函数 — 各模块共用的零依赖 helper。
 *
 * 提取自 dependency/analyzer.ts、memory/session.ts、gateway/cli.ts 中的重复实现。
 */

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
