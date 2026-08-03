/**
 * 消息内容清洗 — 移除可能被 API 拒绝的特殊控制 token。
 *
 * 某些提供商（DeepSeek、Qwen、OpenAI 等）会拒绝用户消息中包含
 * 特殊控制 token（如 <|endoftext|>），防止 prompt injection。
 *
 * 这些 token 可能来自：
 *   - 工具输出（如 bash 运行了推理引擎的输出）
 *   - 用户粘贴的内容
 *   - 模型自身的异常输出
 *
 * 过滤模式：所有 <|...|> 形式的 token 都会被替换为占位符。
 * 这类 token 不应出现在正常对话文本中。
 */
const SPECIAL_TOKEN_RE = /<\|[^|>]*\|>/g;
const REPLACEMENT = '[token]';

/** 清洗单段文本中的特殊 token */
export function sanitizeText(text: string): string {
  return text.replace(SPECIAL_TOKEN_RE, REPLACEMENT);
}

/** 递归清洗对象中所有字符串值 */
export function sanitizeStrings<T>(obj: T): T {
  if (typeof obj === 'string') return sanitizeText(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(sanitizeStrings) as unknown as T;
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj as object)) {
      result[key] = sanitizeStrings((obj as Record<string, unknown>)[key]);
    }
    return result as unknown as T;
  }
  return obj;
}
