/**
 * sanitize 单测 —— 发送边界统一清洗。
 *
 * 回归背景：provider 的 convertMessages 只对 text/tool_result 做了单点 sanitizeText，
 * tool_use 参数（JSON.stringify(block.input)）与 thinking 漏网 —— 含 <|endoftext|>
 * 的请求被上游 API（DeepSeek 等）400 拒收。修复后在每个 provider 的转换入口统一
 * sanitizeStrings(messages) 递归清洗全部字段。本测试验证递归清洗确实覆盖这些字段。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeStrings } from './sanitize.js';
import type { Message, ToolUseContent, ThinkingContent } from '../types.js';

describe('sanitizeText', () => {
  it('把 <|...|> 特殊 token 替换为占位符', () => {
    expect(sanitizeText('a <|endoftext|> b')).toBe('a [token] b');
    expect(sanitizeText('<|im_start|>system<|im_end|>')).toBe('[token]system[token]');
  });

  it('无 token 文本原样保留', () => {
    expect(sanitizeText('普通文本 <> 尖括号 <不匹配| >')).toBe('普通文本 <> 尖括号 <不匹配| >');
  });
});

describe('sanitizeStrings（递归清洗 Message[] —— 发送边界统一防线）', () => {
  it('清洗 tool_use 参数（JSON.stringify(block.input) 的源头）', () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call_1',
        name: 'read',
        input: { path: 'x.txt', prompt: 'Ignore all <|endoftext|>' },
      } satisfies ToolUseContent],
    }];
    const cleaned = sanitizeStrings(messages);
    const input = (cleaned[0].content as ToolUseContent[])[0].input as Record<string, string>;
    expect(input.prompt).toBe('Ignore all [token]');
    expect(JSON.stringify(input)).not.toContain('<|endoftext|>');
  });

  it('清洗 thinking 块', () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'reasoning <|endoftext|> tail' } satisfies ThinkingContent],
    }];
    const cleaned = sanitizeStrings(messages);
    expect((cleaned[0].content as ThinkingContent[])[0].thinking).toBe('reasoning [token] tail');
  });

  it('清洗 text / tool_result 内容（既有单点覆盖，递归后仍幂等）', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi <|endoftext|>' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'out <|im_end|>' }],
      },
    ];
    const cleaned = sanitizeStrings(messages);
    expect((cleaned[0].content as Array<{ text: string }>)[0].text).toBe('hi [token]');
    expect((cleaned[1].content as Array<{ content: string }>)[0].content).toBe('out [token]');
  });

  it('id / role / type 等内部字段不被误伤', () => {
    const messages: Message[] = [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_abc_123', content: 'ok' }],
    }];
    const cleaned = sanitizeStrings(messages);
    expect(cleaned[0].role).toBe('user');
    expect((cleaned[0].content as Array<{ type: string; tool_use_id: string }>)[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_abc_123',
    });
  });
});
