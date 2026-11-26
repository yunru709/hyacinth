/**
 * 工具策略 / 缓存 TTL / Gemini parts 的 **wire 级**契约测试（2026-11-26）
 *
 * 为什么需要：纯函数测试只能证明「映射算得对」，证明不了「adapter 真的把它塞进了请求体」。
 * 2026-11-08 的 system 事故就是「映射/分支存在但没接线」——这类缺口只有捕获请求体才能发现。
 *
 * 做法：`Object.create(prototype)` 绕过构造函数，注入 mock client，调用 createStream，
 * 捕获传给 client 的 params。
 */
import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';

async function* emptyStream() {
  // 故意不产出任何事件：createStream 会走收尾合成 STOP
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) {
    void _;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function captureOpenAI() {
  const captured: any[] = [];
  const o = Object.create(OpenAIProvider.prototype) as any;
  o.model = 'gpt-4o';
  o.maxTokens = 128;
  o.client = {
    chat: {
      completions: {
        create: async (params: any) => {
          captured.push(params);
          return emptyStream();
        },
      },
    },
  };
  return { o, captured };
}

function captureAnthropic() {
  const captured: any[] = [];
  const o = Object.create(AnthropicProvider.prototype) as any;
  o.model = 'claude-sonnet-5';
  o.maxTokens = 128;
  o.thinkingEnabled = false;
  o.thinkingBudget = 0;
  o.thinkingStyle = 'none';
  o.client = {
    messages: {
      stream: (params: any) => {
        captured.push(params);
        return emptyStream();
      },
    },
  };
  return { o, captured };
}

function captureGemini(model: string) {
  const captured: any[] = [];
  const o = Object.create(GeminiProvider.prototype) as any;
  o.model = model;
  o.maxOutputTokens = 128;
  o.thinkingEnabled = true;
  o.client = {
    chats: {
      create: (opts: any) => {
        captured.push({ kind: 'create', opts });
        return {
          sendMessageStream: async (args: any) => {
            // userParts（含 functionResponse.parts）在这里，不在 chats.create 的参数里
            captured.push({ kind: 'send', args });
            return emptyStream();
          },
        };
      },
    },
  };
  return { o, captured };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const messages = [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }];
const tools = [
  {
    name: 'bash',
    description: 'run shell',
    input_schema: { type: 'object', properties: {} },
  },
];

describe('工具策略 wire 注入', () => {
  it('openai：required + parallelToolCalls=false → 请求体带两个字段', async () => {
    const { o, captured } = captureOpenAI();
    o.setToolPolicy({ toolChoice: 'required', parallelToolCalls: false });
    await drain(o.createStream(messages, tools));
    expect(captured[0].tool_choice).toBe('required');
    expect(captured[0].parallel_tool_calls).toBe(false);
  });

  it('anthropic：required + parallelToolCalls=false → any + disable_parallel_tool_use', async () => {
    const { o, captured } = captureAnthropic();
    o.setToolPolicy({ toolChoice: 'required', parallelToolCalls: false });
    await drain(o.createStream(messages, tools));
    expect(captured[0].tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
  });

  it('未设置策略 → 请求体不含任何策略字段（默认行为不变）', async () => {
    const { o: openai, captured: openaiCaptured } = captureOpenAI();
    await drain(openai.createStream(messages, tools));
    expect('tool_choice' in openaiCaptured[0]).toBe(false);
    expect('parallel_tool_calls' in openaiCaptured[0]).toBe(false);

    const { o: anthropic, captured: anthropicCaptured } = captureAnthropic();
    await drain(anthropic.createStream(messages, tools));
    expect('tool_choice' in anthropicCaptured[0]).toBe(false);
  });
});

describe('Anthropic cache_control.ttl 原样透传', () => {
  it('system 块带 ttl=1h → 请求体 system 数组保留 ttl', () => {
    const { o } = captureAnthropic();
    const msgs = [
      {
        role: 'system' as const,
        content: { type: 'text' as const, text: 'persona', cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } },
      },
      { role: 'user' as const, content: { type: 'text' as const, text: 'hi' } },
    ];
    const { system } = o.extractSystemAndMessages(msgs);
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

describe('Gemini functionResponse.parts（模型版本分流）', () => {
  const IMG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'IMG' } };
  const conv = [
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'shot', input: {} }] },
    {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: [{ type: 'text' as const, text: 'see:' }, IMG] }],
    },
  ];

  it('gemini-3 → functionResponse 带 parts（inlineData）', async () => {
    const { o, captured } = captureGemini('gemini-3-pro');
    await drain(o.createStream(conv, tools));
    const sent = captured.find((c: { kind: string }) => c.kind === 'send');
    const json = JSON.stringify(sent);
    expect(json).toContain('inlineData');
    expect(json).toContain('image/png');
  });

  it('gemini-2.x → 不带 parts（降级文本）', async () => {
    const { o, captured } = captureGemini('gemini-2.5-pro');
    await drain(o.createStream(conv, tools));
    const sent = captured.find((c: { kind: string }) => c.kind === 'send');
    const json = JSON.stringify(sent);
    expect(json).not.toContain('inlineData');
  });
});
