/**
 * TruncatingContextComposer 单测（门槛 2：ContextComposerLike 第二个真实实现）。
 * 断言用与实现同源的 estimateMessageTokens 口径，保证自洽。
 */
import { describe, it, expect } from 'vitest';
import { TruncatingContextComposer, estimateMessageTokens } from './truncating-composer.js';
import type { Message } from '../types.js';
import type { LayeredComposeOptions } from './interface.js';

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: { type: 'text', text } };
}

const CJK_HEAVY = '层'.repeat(50); // 50 token / 条
const LIGHT = 'x'.repeat(40); // 10 token / 条

function layeredOpts(over: Partial<LayeredComposeOptions> = {}): LayeredComposeOptions {
  return {
    sessionDir: '/tmp/trunc',
    maxContextTokens: 1000,
    cwd: process.cwd(),
    timestamp: '2026-09-02 00:00',
    tools: [],
    history: [],
    userInput: '',
    ...over,
  };
}

const composer = new TruncatingContextComposer();

describe('TruncatingContextComposer（门槛 2 真实替换件）', () => {
  it('预算内不动 history：原样返回，truncated = 0', async () => {
    const history = [textMsg('user', LIGHT), textMsg('assistant', LIGHT)];
    const out = await composer.compose(layeredOpts({ history, userInput: 'hi' }));
    expect(out.messages).toHaveLength(3);
    expect(out.zoneBreakdown.truncated).toBe(0);
  });

  it('超预算：从最旧起截断，直到总估算 ≤ 预算（激进：不保中间细节）', async () => {
    // 30 条 × 50 token ≈ 1500 > 1000*0.9 —— 必截断
    const history = Array.from({ length: 30 }, (_, i) =>
      textMsg(i % 2 === 0 ? 'user' : 'assistant', `${CJK_HEAVY}#${i}`),
    );
    const out = await composer.compose(layeredOpts({ history, userInput: '最后一句' }));
    const total = out.messages.reduce((a, m) => a + estimateMessageTokens(m), 0);
    expect(total).toBeLessThanOrEqual(900);
    expect(out.zoneBreakdown.truncated).toBeGreaterThan(0);
    // 尾部窗口保留：最后一条 history 仍在、userInput 在末尾
    expect(messageTextOf(out.messages[out.messages.length - 1])).toBe('最后一句');
    const lastHistory = history[history.length - 1];
    expect(out.messages.some((m) => m.role === lastHistory.role && messageTextOf(m) === `${CJK_HEAVY}#29`)).toBe(true);
    // 最旧被丢
    expect(out.messages.some((m) => messageTextOf(m) === `${CJK_HEAVY}#0`)).toBe(false);
  });

  it('过滤 system 与纯 thinking 历史消息（对齐内置组装语义）', async () => {
    const history: Message[] = [
      { role: 'system', content: { type: 'text', text: '人设' } },
      { role: 'assistant', content: { type: 'thinking', thinking: '内心' } },
      textMsg('user', '真消息'),
    ];
    const out = await composer.compose(layeredOpts({ history, userInput: '' }));
    expect(out.messages).toHaveLength(1);
    expect(messageTextOf(out.messages[0])).toBe('真消息');
  });

  it('historyTransform 生效：变换后输出随过滤', async () => {
    const history = [textMsg('user', 'a'), textMsg('user', 'b')];
    const out = await composer.compose(layeredOpts({
      history,
      historyTransform: (msgs) => msgs.filter((m) => messageTextOf(m) !== 'a'),
    }));
    expect(out.messages.map(messageTextOf)).toEqual(['b']);
  });

  it('userInput 与末条 user 同文本时不重复追加', async () => {
    const history = [textMsg('user', '重复输入')];
    const out = await composer.compose(layeredOpts({ history, userInput: '重复输入' }));
    expect(out.messages).toHaveLength(1);
  });

  it('legacy ComposeOptions 分支：systemPrompt 置首，返回 Message[]', async () => {
    const out = await composer.compose({
      systemPrompt: '你是一个助手',
      tools: [],
      history: [textMsg('user', '旧问题'), textMsg('assistant', '旧回答')],
      userInput: '新问题',
      maxContextTokens: 1000,
    });
    // 判别：返回数组而非 { messages, zoneBreakdown }
    expect(Array.isArray(out)).toBe(true);
    const msgs = out as Message[];
    expect(msgs[0].role).toBe('system');
    expect(messageTextOf(msgs[msgs.length - 1])).toBe('新问题');
  });

  it('activeConditions 字段存在且可被写入（knowledge 插件 add zone4_enabled 的语义）', () => {
    const c = new TruncatingContextComposer();
    expect(c.activeConditions instanceof Set).toBe(true);
    c.activeConditions.add('zone4_enabled');
    expect(c.activeConditions.has('zone4_enabled')).toBe(true);
  });

  it('image 消息按固定视觉成本计入，超预算时最旧 image 优先被截断', async () => {
    const imgMsg = (i: number): Message => ({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(10) } },
        { type: 'text', text: `img-${i}` },
      ],
    });
    // 3 张图 ≈ 3×~1203 > 4000*0.9=3600 → 截断 1 张；剩 2 张 ~2406 ≤ 3600
    const history = [imgMsg(0), imgMsg(1), imgMsg(2)];
    const out = await composer.compose(layeredOpts({ history, userInput: '', maxContextTokens: 4000 }));
    expect(out.zoneBreakdown.truncated).toBe(1);
    expect(out.messages.some((m) => messageTextOf(m) === 'img-1')).toBe(true);
    expect(out.messages.some((m) => messageTextOf(m) === 'img-2')).toBe(true);
    expect(out.messages.some((m) => messageTextOf(m) === 'img-0')).toBe(false);
  });
});

function messageTextOf(m: Message): string {
  const blocks = Array.isArray(m.content) ? m.content : [m.content];
  return blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}
