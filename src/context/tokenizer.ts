import { encodingForModel } from 'js-tiktoken';
import type {
  Message,
  MessageContent,
  TextContent,
  ThinkingContent,
  ToolUseContent,
  ToolResultContent,
  ImageContent,
} from '../types.js';
import type { ContextConfig } from '../setup/config.js';

// --- Lazy singleton encoding ---

let _encoding: ReturnType<typeof encodingForModel> | null = null;

function getEncoding() {
  if (!_encoding) {
    _encoding = encodingForModel('gpt-4');
  }
  return _encoding;
}

// --- TokenCounter ---

export class TokenCounter {
  /**
   * Count tokens for a plain text string.
   */
  countTokens(text: string): number {
    return getEncoding().encode(text).length;
  }

  /**
   * Count tokens for a single Message object.
   *
   * Overhead model:
   *  - 4 tokens per message for role framing
   *  - TextContent:       text tokens + 4
   *  - ToolUseContent:    JSON.stringify(input) tokens + name tokens + 4
   *  - ToolResultContent: content tokens + 4
   */
  countMessageTokens(message: Message): number {
    let tokens = 4; // role overhead per message

    const contents = Array.isArray(message.content)
      ? message.content
      : [message.content];

    for (const part of contents) {
      tokens += this.#countContentTokens(part);
    }

    return tokens;
  }

  /**
   * Count tokens for an array of messages.
   */
  countMessagesTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + this.countMessageTokens(msg), 0);
  }

  #countContentTokens(content: MessageContent): number {
    switch (content.type) {
      case 'text': {
        const tc = content as TextContent;
        return this.countTokens(tc.text) + 4;
      }
      case 'tool_use': {
        const tuc = content as ToolUseContent;
        const inputTokens = this.countTokens(JSON.stringify(tuc.input));
        const nameTokens = this.countTokens(tuc.name);
        return inputTokens + nameTokens + 4;
      }
      case 'thinking': {
        const tc = content as ThinkingContent;
        return this.countTokens(tc.thinking) + 4;
      }
      case 'tool_result': {
        const trc = content as ToolResultContent;
        return this.countTokens(trc.content) + 4;
      }
      case 'image': {
        const img = content as ImageContent;
        if (img.source.type === 'url') return 1000;  // 远程 URL，保守估算
        // base64: decoded ≈ data.length * 0.75 bytes, ~1 token per 4 bytes
        return Math.max(1, Math.ceil(img.source.data.length * 0.75 / 4)) + 4;
      }
      default: {
        // Unknown content type — best-effort: stringify and count
        const _exhaustive: never = content;
        return this.countTokens(JSON.stringify(_exhaustive)) + 4;
      }
    }
  }
}


