/**
 * tool_result 内容的归一化工具（2026-11-26）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 背景
 * ────────────────────────────────────────────────────────────────────────────
 * `ToolResultContent.content` 原本只能是 `string`，但官方协议已经分厂商支持
 * "工具结果带图片"：
 *   - Anthropic：`tool_result.content` 接受 `string | Array<TextBlockParam | ImageBlockParam | ...>`
 *   - Gemini 3+：`FunctionResponse.parts` 可带图片
 *   - OpenAI Chat Completions：**只接受文本**（tool 消息 content 是 string | TextPart[]）
 * ⇒ 内部模型放宽为 `string | Array<TextContent | ImageContent>`，各适配器按能力降级/直发。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这组函数
 * ────────────────────────────────────────────────────────────────────────────
 * 压缩器（`context/compressor.ts`）对 `tool_result.content` 做了大量**字符串假设**：
 * `md5(content)`、`content.match(...)`、模板拼接、`truncateDegradedToolResult`。
 * 一旦 content 变成数组，这些会静默算错哈希、把图片变成 `[object Object]`。
 * ⇒ 所有消费方必须先走 `toolResultToText()` 归一为文本；需要结构化块时才用
 *   `toolResultBlocks()`。
 *
 * ⚠️ 新增消费方时：**不要**直接对 `content` 做字符串操作，先归一。
 */

import type { ImageContent, TextContent, ToolResultContent } from '../types.js';

/** tool_result 允许携带的结构化块（目前只有文本与图片） */
export type ToolResultBlock = TextContent | ImageContent;

/** 把 content 归一为结构化块数组（字符串包成单个 text 块） */
export function toolResultBlocks(content: ToolResultContent['content']): ToolResultBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  return content;
}

/**
 * 把 content 归一为纯文本（用于哈希、摘要、日志、以及不支持图片的上游降级）。
 *
 * 图片 → `[Image: mime]` 或 `[Image URL: ...]` 占位，与各适配器的降级文案保持一致。
 */
export function toolResultToText(content: ToolResultContent['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      return b.source.type === 'base64'
        ? `[Image: ${b.source.media_type}]`
        : `[Image URL: ${b.source.url}]`;
    })
    .join('');
}

/** 是否含有图片块（供适配器决定"直发还是降级"） */
export function hasToolResultImages(content: ToolResultContent['content']): boolean {
  return typeof content !== 'string' && content.some((b) => b.type === 'image');
}
