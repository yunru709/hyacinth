/**
 * TokenCounter 单测。
 *
 * 回归背景：js-tiktoken 的 encode 默认**禁止**特殊 token，文本含 `<|endoftext|>`
 * 会抛 `The text contains a special token that is not allowed: ...`。会话历史 /
 * 工具输出可能天然含这类 token（如模型原样输出的 EOS），上下文组装计数时即炸。
 * 修复：encode 的 allowedSpecial 传 'all'（特殊 token 按 1 token 计，与真实 LLM
 * 一致）；发送层清洗（provider/sanitize）负责防止 API 拒收。
 */
import { describe, it, expect } from 'vitest';
import { TokenCounter } from './tokenizer.js';
import type { Message, ToolUseContent, ToolResultContent, ThinkingContent } from '../types.js';

const counter = new TokenCounter();

describe('图片 token 估算（官方上界）', () => {
  it('图片不随 base64 长度膨胀：456KB 的图 ≈ 上界，而不是 ~117K ✗', () => {
    const counter = new TokenCounter();
    const msg = (n: number) => ({ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(n) } },
    ] });
    const small = counter.countMessageTokens(msg(1024) as never);
    const big = counter.countMessageTokens(msg(456 * 1024) as never);
    expect(big, '官方上限 1024（含少量结构开销）').toBeLessThanOrEqual(1024 + 16);
    expect(big, '不应随 base64 长度增长（旧实现这里会到 ~117K）').toBe(small);
    expect(big).toBeGreaterThan(0);
  });
});

describe('TokenCounter.countTokens（容忍特殊 token）', () => {
  it('普通文本正常计数', () => {
    expect(counter.countTokens('hello world')).toBeGreaterThan(0);
    expect(counter.countTokens('')).toBe(0);
  });

  it('含 <|endoftext|> 的文本不抛错且正常计数（回归：tiktoken 默认禁止特殊 token）', () => {
    const n = counter.countTokens('a <|endoftext|> b');
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThan(0);
  });
});

describe('TokenCounter.countMessageTokens（消息级，含 tool_use / thinking / tool_result）', () => {
  it('tool_use 参数含特殊 token 不抛错', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call_1',
        name: 'read',
        input: { prompt: 'x <|endoftext|>' },
      } satisfies ToolUseContent],
    };
    expect(counter.countMessageTokens(msg)).toBeGreaterThan(0);
  });

  it('thinking / tool_result 含特殊 token 不抛错', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't <|im_end|>' } satisfies ThinkingContent] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'r <|endoftext|>' } satisfies ToolResultContent] },
    ];
    for (const m of messages) expect(counter.countMessageTokens(m)).toBeGreaterThan(0);
    expect(counter.countMessagesTokens(messages)).toBeGreaterThan(0);
  });
});
