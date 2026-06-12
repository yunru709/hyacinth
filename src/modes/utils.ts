/** 从完整消息内容中提取文本部分（跳过 thinking/tool_use 等非文本块） */
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
