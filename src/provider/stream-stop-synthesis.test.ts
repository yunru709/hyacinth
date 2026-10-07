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
 * 实现方式：**全部 5 个 provider 都用假 HTTP 上游**驱动真实代码路径（各家都支持
 * baseUrl / endpoint 注入），没有任何 vi.mock —— 格式均先经探针确认，不是猜的。
 *
 * ⚠️ Gemini 能走假上游这件事本身就是一条断言：它依赖 gemini.ts 用
 * `httpOptions.baseUrl`（而不是被 SDK 静默忽略的顶层 `baseURL`）注入端点。
 * 若哪天有人把它改回顶层写法，本文件会立刻红 —— 这正是我们想要的回归保护。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

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
/** Gemini 的收尾原因（undefined = 不发，模拟断流） */
let geminiFinish: string | undefined;

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

/** Gemini（@google/genai SSE）：一段文本 + 可选的 finishReason */
function geminiStream(): string {
  return sse({
    candidates: [
      {
        content: { parts: [{ text: '部分内容' }], role: 'model' },
        ...(geminiFinish ? { finishReason: geminiFinish } : {}),
      },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
  });
}

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const url = req.url ?? '';
      if (url.includes(':streamGenerateContent')) res.write(geminiStream());
      else if (url.includes('/messages')) res.write(anthropicStream(mode === 'clean'));
      else res.write(openAiStream(mode === 'clean'));
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
  geminiFinish = undefined;
});

async function collect(p: { createStream(m: Message[]): AsyncIterable<StreamEvent> }): Promise<StreamEvent[]> {
  const evs: StreamEvent[] = [];
  for await (const e of p.createStream([MSG])) evs.push(e);
  return evs;
}

const stopsOf = (evs: StreamEvent[]) => evs.filter((e) => e.type === 'STOP') as Array<{ reason: string }>;
const toolsOf = (evs: StreamEvent[]) =>
  evs.filter((e) => e.type === 'TOOL_USE') as unknown as Array<{ name: string; incomplete?: boolean }>;

type Maker = () => { createStream(m: Message[]): AsyncIterable<StreamEvent> };

// ── 5 个 provider（全部走假上游的真实代码路径）──────────────────────────

describe('断流合成 STOP：走假上游的真实 provider 路径', () => {
  const factories: Array<[string, Maker]> = [
    ['OpenAIProvider', () => new OpenAIProvider({ apiKey: 'test', baseUrl: base, model: 'gpt-5.5' })],
    // 本地服务：显式给 /v1 让 openai SDK 打到 /v1/chat/completions
    ['LocalProvider', () => new LocalProvider({ baseUrl: `${base}/v1`, model: 'test-model' })],
    ['LlamaCppProvider', () => new LlamaCppProvider({ endpoint: base, model: 'test-model' })],
    ['AnthropicProvider', () => new AnthropicProvider({ apiKey: 'test', baseUrl: base, model: 'claude-sonnet-5' })],
    // 这条同时守住 gemini.ts 的端点注入必须走 httpOptions.baseUrl（否则假上游收不到请求、
    // geminiFinish 无从生效，下面的断言会直接红）
    ['GeminiProvider', () => new GeminiProvider({ apiKey: 'test', baseUrl: base, model: 'gemini-3.6-flash' })],
  ];

  it.each(factories)('%s：流结束但无收尾信号 ⇒ 恰好一个 STOP 且 reason=incomplete', async (_name, make) => {
    mode = 'cut';
    geminiFinish = undefined;
    const evs = await collect(make());
    const stops = stopsOf(evs);
    expect(stops, '必须合成 STOP').toHaveLength(1);
    expect(stops[0]!.reason).toBe('incomplete');
    // 且必须发生在所有内容之后（收尾语义）
    expect(evs[evs.length - 1]!.type).toBe('STOP');
  });

  it.each(factories.slice(0, 4))('%s：正常收尾 ⇒ 不得被误判成 incomplete', async (_name, make) => {
    mode = 'clean';
    const evs = await collect(make());
    const stops = stopsOf(evs);
    expect(stops, '恰好一个 STOP').toHaveLength(1);
    expect(stops[0]!.reason, '正常收尾不该被改写成 incomplete').not.toBe('incomplete');
  });

  // tool call 补发只对「有累积」的三个实现成立
  // （anthropic 在 content_block_stop 即时 emit；gemini 在 part.functionCall 即时 emit）
  const accumulating: Array<[string, Maker]> = [
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

// ── Gemini：按 finishReason 归一（原实现无条件 end_turn）──────────────────

describe('GeminiProvider：按 finishReason 归一（原实现无条件 end_turn）', () => {
  const make: Maker = () => new GeminiProvider({ apiKey: 'test', baseUrl: base, model: 'gemini-3.6-flash' });

  it('从未拿到 finishReason ⇒ incomplete（断流）', async () => {
    geminiFinish = undefined;
    const stops = stopsOf(await collect(make()));
    expect(stops).toHaveLength(1);
    expect(stops[0]!.reason).toBe('incomplete');
  });

  it('finishReason=MAX_TOKENS ⇒ 归一为 length（交给截断保护提示+续写）', async () => {
    geminiFinish = 'MAX_TOKENS';
    const stops = stopsOf(await collect(make()));
    expect(stops[0]!.reason, '被截断必须显形为 length，否则截断保护对 Gemini 永不生效').toBe('length');
  });

  it('finishReason=STOP ⇒ end_turn（正常）', async () => {
    geminiFinish = 'STOP';
    const stops = stopsOf(await collect(make()));
    expect(stops[0]!.reason).toBe('end_turn');
  });

  it('finishReason=SAFETY ⇒ 原样小写（不是长度问题，不该建议调上限）', async () => {
    geminiFinish = 'SAFETY';
    const stops = stopsOf(await collect(make()));
    expect(stops[0]!.reason).toBe('safety');
  });
});
