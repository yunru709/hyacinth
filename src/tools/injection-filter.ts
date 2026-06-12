import { createLogger } from '../logging/logger.js';

const logger = createLogger('injection-filter');

/** 提示词注入检测模式 */
const PATTERNS = [
  'ignore previous instructions',
  'ignore all previous',
  'disregard all',
  'forget your instructions',
  'you are now',
  'new instructions:',
];

const SYSTEM_TAG_RE = /<system>[\s\S]*?<\/system>/gi;
const IM_START_RE = /<\|im_start\|>system[\s\S]*?<\|im_end\|>/gi;
const BRACKET_SYSTEM_RE = /^\s*\[(SYSTEM(?:\s+INSTRUCTION)?)\]\s*/gim;

/**
 * 清洗工具返回结果中的提示词注入内容。
 * 在工具结果进入对话上下文之前调用，从源头阻断外部注入。
 */
export function sanitizeToolResult(content: string): string {
  if (!content || content.length === 0) return content;

  let text = content;
  let stripped = false;

  // 移除 XML/标记风格的 system 标签
  const afterSystemTag = text.replace(SYSTEM_TAG_RE, '');
  if (afterSystemTag !== text) { text = afterSystemTag; stripped = true; }

  const afterImStart = text.replace(IM_START_RE, '');
  if (afterImStart !== text) { text = afterImStart; stripped = true; }

  const afterBracket = text.replace(BRACKET_SYSTEM_RE, '');
  if (afterBracket !== text) { text = afterBracket; stripped = true; }

  // 移除已知注入模式
  const lower = text.toLowerCase();
  for (const pattern of PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      const re = new RegExp(pattern, 'gi');
      text = text.replace(re, '');
      stripped = true;
    }
  }

  if (stripped) {
    logger.warn('[Security] Stripped injection pattern from tool result');
  }

  return text;
}
