/**
 * 断流不再静默：各 provider「流结束但全程没有收尾信号」时合成 STOP（2026-10-07）
 *
 * 背景（实测事故）：思考型模型经聚合中转时推理期会长时间一个 delta 都不推，
 * 被 ResilientProvider 的 idle 超时反复 abort；最终那次流结束时**没有 finish_reason**，
 * 于是 stopReason 落空 ⇒ finalize 的 `state.stopReason || 'end_turn'` 把它当正常收尾
 * ⇒ 截断续写保护（只认 length/max_tokens/incomplete）不触发 ⇒ 用户侧静默截断、零提示。
 *
 * 本文件守住两件事：
 *   ① 断流 ⇒ 必须合成 STOP reason='incomplete'（且补发被切断的 tool call，标 incomplete）
 *   ② 正常收尾 ⇒ **不得**被误判成 incomplete（否则每次正常回复都会白续写 3 次）
 *
 * 实现方式：用**假 HTTP 上游**驱动真实 provider 代码路径（4 个 provider 都支持
 * baseUrl/endpoint 注入），只有 Gemini 因 SDK 走 vi.mock（见文件末尾说明）。
 * 格式均先经探针确认，不是猜的。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Gemini 的 SDK mock（vi.mock 会被提升，故用 vi.hoisted 传递可控 chunk）──────
// 注：gemini.ts 用 `...(opts.baseUrl ? { baseURL: opts.baseUrl } : {})`，而 @google/genai
// 的 GoogleGenAIOptions **没有顶层 baseURL**（正确写法是 httpOptions.baseUrl）⇒ 该字段
// 被 SDK 静默忽略、假服务器收不到任何请求。这是独立缺陷，另行上报；此处绕开它。
const hoisted = vi.hoisted(() => ({ geminiChunks: [] as unknown[] }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    chats = {
      create: () => ({
        sendMessageStream: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const c of hoisted.geminiChunks) yield c;
          },
        }),
      }),
    };
  },
}));

import { OpenAIProvider } from './openai.js';
import { LocalProvider } from './local.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { LlamaCppProvider } from '../local-model/llamacpp-provider.js';
import type { Message, StreamEvent } from '../types.js';

const MSG: Message = { role: 'user', content: [{ type: 'text', text: 'hi' }] };

// ── 假上游：按 URL 分发各协议格式；clean=true 时给完整收尾信号 ──────────────
type Mode = 'cut' | 'clean';
let mode: Mode = 'cut';

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

/** OpenAI 兼容：一段文本 + 一个**未收尾**的 tool call；clean 时补 finish_reason + [DONE] */
function openAiStream(clean: boolean): string {
  const base = { id: '1', object: 'chat.completion.chunk', created: 0, model: 'm' };
  let out =
    sse({ ...base, choices: [{ index: 0, delta: { content: '部分内容' }, finish_reason: null }] }) +
    sse({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_z', function: { name: 'write', arguments: '{"file_path":"a.txt"}' } }] },
          finish_reason: null,
        },
      ],
    });
  if (clean) {
    out += sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    out += 'data: [DONE]\n\n';
  }
  return out;
}

/** Anthropic：message_start + text delta；clean 时补 message_delta(stop_reason) */
function anthropicStream(clean: boolean): string {
  let out =
    'event: message_start\ndata: ' +
    JSON.stringify({
      type: 'message_start',
      message: {
        id: 'm1', type: 'message', role: 'assistant', model: 'claude',
        content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 },
      },
    }) +
    '\n\n' +
    'event: content_block_start\ndata: ' +
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    '\n\n' +
    'event: content_block_delta\ndata: ' +
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部分内容' } }) +
    '\n\n';
  if (clean) {
    out +=
      'event: message_delta\ndata: ' +
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) +
      '\n\n';
  }
  return out;
}

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const url = req.url ?? '';
      res.write(url.includes('/messages') ? anthropicStream(mode === 'clean') : openAiStream(mode === 'clean'));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  mode = 'cut';
});

async function collect(p: { createStream(m: Message[]): AsyncIterable<StreamEvent> }): Promise<StreamEvent[]> {
  const evs: StreamEvent[] = [];
  for await (const e of p.createStream([MSG])) evs.push(e);
  return evs;
}

const stopsOf = (evs: StreamEvent[]) => evs.filter((e) => e.type === 'STOP') as Array<{ reason: string }>;
const toolsOf = (evs: StreamEvent[]) =>
  evs.filter((e) => e.type === 'TOOL_USE') as unknown as Array<{ name: string; incomplete?: boolean }>;

// ── 4 个支持 endpoint 注入的 provider ─────────────────────────────────────

describe('断流合成 STOP：走假上游的真实 provider 路径', () => {
  const factories: Array<[string, () => { createStream(m: Message[]): AsyncIterable<StreamEvent> }]> = [
    ['OpenAIProvider', () => new OpenAIProvider({ apiKey: 'test', baseUrl: base, model: 'gpt-5.5' })],
    // 本地服务：8080 端口 → llamacpp 后端；这里显式给 /v1 让 openai SDK 打到 /v1/chat/completions
    ['LocalProvider', () => new LocalProvider({ baseUrl: `${base}/v1`, model: 'test-model' })],
    ['LlamaCppProvider', () => new LlamaCppProvider({ endpoint: base, model: 'test-model' })],
    ['AnthropicProvider', () => new AnthropicProvider({ apiKey: 'test', baseUrl: base, model: 'claude-sonnet-5' })],
  ];

  it.each(factories)('%s：流结束但无收尾信号 ⇒ 恰好一个 STOP 且 reason=incomplete', async (_name, make) => {
    mode = 'cut';
    const evs = await collect(make());
    const stops = stopsOf(evs);
    expect(stops, '必须合成 STOP').toHaveLength(1);
    expect(stops[0]!.reason).toBe('incomplete');
    // 且必须发生在所有内容之后（收尾语义）
    expect(evs[evs.length - 1]!.type).toBe('STOP');
  });

  it.each(factories)('%s：正常收尾 ⇒ 不得被误判成 incomplete', async (_name, make) => {
    mode = 'clean';
    const evs = await collect(make());
    const stops = stopsOf(evs);
    expect(stops, '恰好一个 STOP').toHaveLength(1);
    expect(stops[0]!.reason, '正常收尾不该被改写成 incomplete').not.toBe('incomplete');
  });

  // tool call 补发只对「有累积」的三个实现成立（anthropic 在 content_block_stop 即时 emit）
  const accumulating: Array<[string, () => { createStream(m: Message[]): AsyncIterable<StreamEvent> }]> = [
    ['OpenAIProvider', () => new OpenAIProvider({ apiKey: 'test', baseUrl: base, model: 'gpt-5.5' })],
    ['LocalProvider', () => new LocalProvider({ baseUrl: `${base}/v1`, model: 'test-model' })],
    ['LlamaCppProvider', () => new LlamaCppProvider({ endpoint: base, model: 'test-model' })],
  ];

  it.each(accumulating)('%s：断流时被切断的 tool call 不丢，且标 incomplete', async (_name, make) => {
    mode = 'cut';
    const evs = await collect(make());
    const tools = toolsOf(evs);
    expect(tools, 'tool call 必须在收尾时补发').toHaveLength(1);
    expect(tools[0]!.name).toBe('write');
    expect(tools[0]!.incomplete, '流被切断 ⇒ 参数不可信，必须标 incomplete').toBe(true);
  });
});

// ── Gemini：SDK 走 mock，但断言的是**真实的归一逻辑** ────────────────────

describe('GeminiProvider：按 finishReason 归一（原实现无条件 end_turn）', () => {
  const chunk = (finishReason?: string) => ({
    candidates: [
      { content: { parts: [{ text: '部分内容' }], role: 'model' }, ...(finishReason ? { finishReason } : {}) },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
  });
  const make = () => new GeminiProvider({ apiKey: 'test', model: 'gemini-3.6-flash' });

  it('从未拿到 finishReason ⇒ incomplete（断流）', async () => {
    hoisted.geminiChunks = [chunk()];
    const stops = stopsOf(await collect(make()));
    expect(stops).toHaveLength(1);
    expect(stops[0]!.reason).toBe('incomplete');
  });

  it('finishReason=MAX_TOKENS ⇒ 归一为 length（交给截断保护提示+续写）', async () => {
    hoisted.geminiChunks = [chunk('MAX_TOKENS')];
    const stops = stopsOf(await collect(make()));
    expect(stops[0]!.reason, '被截断必须显形为 length，否则截断保护对 Gemini 永不生效').toBe('length');
  });

  it('finishReason=STOP ⇒ end_turn（正常）', async () => {
    hoisted.geminiChunks = [chunk('STOP')];
    const stops = stopsOf(await collect(make()));
    expect(stops[0]!.reason).toBe('end_turn');
  });

  it('finishReason=SAFETY ⇒ 原样小写（不是长度问题，不该建议调上限）', async () => {
    hoisted.geminiChunks = [chunk('SAFETY')];
    const stops = stopsOf(await collect(make()));
    expect(stops[0]!.reason).toBe('safety');
  });
});
