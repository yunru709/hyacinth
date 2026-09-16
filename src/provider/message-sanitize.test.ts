/**
 * 报文序列兜底清理 —— 回归测试。
 *
 * 锁定的真实事故：会话历史里出现「无主 tool_result」（assistant 只有
 * thinking/text、没有 tool_calls），DeepSeek 直接 400
 *   Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
 * 转换层必须丢弃这类孤儿消息，保证报文序列对严格厂商合法。
 */
import { describe, it, expect } from 'vitest';
import { dropOrphanToolMessages } from './message-sanitize.js';

type Msg = Record<string, unknown>;

const assistant = (toolCalls?: string[]): Msg =>
  toolCalls
    ? { role: 'assistant', content: '', tool_calls: toolCalls.map((id) => ({ id, type: 'function', function: { name: 'bash', arguments: '{}' } })) }
    : { role: 'assistant', content: 'thinking only' };
const tool = (id: string): Msg => ({ role: 'tool', tool_call_id: id, content: 'ok' });
const user = (text = 'hi'): Msg => ({ role: 'user', content: text });

describe('dropOrphanToolMessages', () => {
  it('合法的 tool 序列原样保留', () => {
    const input = [assistant(['a', 'b']), tool('a'), tool('b'), user()];
    expect(dropOrphanToolMessages(input)).toEqual(input);
  });

  it('丢弃「assistant 无 tool_calls 却跟 tool 消息」的孤儿（真实事故形态）', () => {
    const orphan = tool('call_gmfymf2diwnkpv2v7tlvvipu');
    const input = [user('继续'), assistant(), orphan, user('看不到')];
    const out = dropOrphanToolMessages(input);
    expect(out).toHaveLength(3);
    expect(out).not.toContain(orphan);
    // 其余消息顺序与内容不变
    expect(out[0]).toEqual(input[0]);
    expect(out[1]).toEqual(input[1]);
    expect(out[2]).toEqual(input[3]);
  });

  it('被 user 文本隔断后的同 id tool 消息也算孤儿', () => {
    const input = [assistant(['a']), user('插话'), tool('a')];
    const out = dropOrphanToolMessages(input);
    expect(out).toHaveLength(2);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('tool_call_id 缺失或非字符串 → 丢弃', () => {
    const input = [assistant(['a']), { role: 'tool', content: 'x' }, { role: 'tool', tool_call_id: 42, content: 'y' }, tool('a')];
    const out = dropOrphanToolMessages(input);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('同一 id 只消费一次（重复回应 → 第二条为孤儿）', () => {
    const input = [assistant(['a']), tool('a'), tool('a')];
    const out = dropOrphanToolMessages(input);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('无 tool 消息的历史不受影响', () => {
    const input = [user(), assistant(), user('再来')];
    expect(dropOrphanToolMessages(input)).toEqual(input);
  });
});
