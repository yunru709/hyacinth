import { encodingForModel } from 'js-tiktoken';
import type {
  Message,
  MessageContent,
  TextContent,
  ThinkingContent,
  ToolUseContent,
  ToolResultContent,
  ImageContent,
  VideoContent,
  AudioContent,
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

/**
 * 单张图片的 token **上界** —— 官方口径（DeepSeek「图像理解 › Token 用量」）。
 *
 * 官方规则：图片按尺寸折算 token；进模型前自动缩放（小于约 544×544 者按长宽比放大，
 * 更大者按长宽比缩小到约 1300×1300 等效像素）⇒ **每张图上限 1024 tokens**
 * （所以 2000×2000 与 5000×5000 缩放后消耗相同；多图每张独立计算）。
 *
 * 为什么取上界而不是精算：这是**发送前的预算估算**（用于压缩判定），
 * 取上界**不会低估**（宁可略早压缩，也不至于溢出），且与常见大图基本吻合 ✓。
 *
 * 反面教材（2026-09-19 修）：旧实现按 base64 字节数折算（data.length * 0.75 / 4）✗
 * ⇒ 一张 456 KB 的图被算成 ~117K tokens（实测 harness 报 116869）—— 约 114 倍虚高 ✗，
 * 显示上"读图暴涨几百 K"，且把压缩阈值判定也带偏 ✗。
 */
const IMAGE_TOKEN_UPPER_BOUND = 1024;

export class TokenCounter {
  /**
   * Count tokens for a plain text string.
   *
   * encode 的 allowedSpecial 传 'all'：tiktoken 默认**禁止**特殊 token，文本含
   * `<|endoftext|>` 等会直接抛错（`The text contains a special token that is not
   * allowed: ...`）。会话历史 / 工具输出可能天然含这类 token（如模型原样输出的
   * EOS）。计数层应忠实计数（特殊 token 按 1 token 计，与真实 LLM 一致）；
   * 发送层清洗（provider/sanitize）负责防止 API 拒收 —— 两层职责分离。
   */
  countTokens(text: string): number {
    return getEncoding().encode(text, 'all').length;
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
        // 官方上界（见 IMAGE_TOKEN_UPPER_BOUND 注释）；URL 与 base64 都是同一张图 ⇒ 同价 ✓
        return IMAGE_TOKEN_UPPER_BOUND;
      }
      // ⚠️ 未收口（2026-09-19）：video/audio 仍是"按 base64 字节数折算"✗，同样会虚高 ——
      //   本次只按官方文档修了 image（唯一有权威口径的）。原生视频/音频注入是少数路径，
      //   而**视频抽帧**走的是 image 分支 ✓（已被上界覆盖 ✓）。要修需先拿到对应厂商的口径。
      case 'video': {
        const v = content as VideoContent;
        if (v.source.type === 'file') return 200; // 文件引用占位
        if (v.source.type === 'url') return 2000; // 远程视频粗估
        return Math.max(1, Math.ceil(v.source.data.length * 0.75 / 4)) + 4;
      }
      case 'audio': {
        const a = content as AudioContent;
        if (a.source.type === 'file') return 200; // 文件引用占位
        if (a.source.type === 'url') return 1500; // 远程音频粗估
        return Math.max(1, Math.ceil(a.source.data.length * 0.75 / 4)) + 4;
      }
      default: {
        // Unknown content type — best-effort: stringify and count
        const _exhaustive: never = content;
        return this.countTokens(JSON.stringify(_exhaustive)) + 4;
      }
    }
  }
}


