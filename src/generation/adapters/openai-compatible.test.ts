// openai-compatible 适配器单测（stub 全局 fetch，无网络）——TTS / 文生图双轨
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleProvider } from './openai-compatible.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeProvider(overrides: Record<string, unknown> = {}) {
  return new OpenAICompatibleProvider('local-tts', {
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000',
    models: { audio_tts: 'my-tts-model' },
    voice: 'zhi',
    ...overrides,
  } as never);
}

const REQ = {
  provider: 'local-tts',
  taskType: 'audio_tts' as const,
  prompt: '你好呀，今天天气真不错。',
};

describe('openai-compatible TTS 适配器', () => {
  it('成功：POST /v1/audio/speech，音频字节转 data URL，initialStatus=success', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
    }) as unknown as typeof fetch;

    const task = await makeProvider().submitTask(REQ);
    expect(task.initialStatus?.status).toBe('success');
    expect(task.initialStatus?.resultUrl).toMatch(/^data:audio\/mpeg;base64,/);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8000/v1/audio/speech');
    expect(calls[0]!.body).toEqual({
      model: 'my-tts-model',
      input: REQ.prompt,
      voice: 'zhi',
      response_format: 'mp3',
      speed: 1,
    });
  });

  it('请求参数优先级：req.voice / req.model 覆盖配置默认', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return new Response(new Uint8Array([1]).buffer, { status: 200 });
    }) as unknown as typeof fetch;

    await makeProvider().submitTask({ ...REQ, voice: 'custom', model: 'custom-model' });
    expect(bodies[0]!.voice).toBe('custom');
    expect(bodies[0]!.model).toBe('custom-model');
  });

  it('HTTP 500 → failed 任务，errorCode=HTTP_500 且带服务端错误详情', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('model not found', { status: 500 }),
    ) as unknown as typeof fetch;

    const task = await makeProvider().submitTask(REQ);
    expect(task.initialStatus?.status).toBe('failed');
    expect(task.initialStatus?.errorCode).toBe('HTTP_500');
    expect(task.initialStatus?.errorMessage).toContain('model not found');
  });

  it('本地服务器回 WAV（忽略请求的 mp3）→ 按 RIFF 魔数标记 audio/wav', async () => {
    // 最小合法 WAV 头：RIFF....WAVE
    const wav = new Uint8Array(44);
    const view = new DataView(wav.buffer);
    ['R', 'I', 'F', 'F'].forEach((c, i) => (wav[i] = c.charCodeAt(0)));
    ['W', 'A', 'V', 'E'].forEach((c, i) => (wav[8 + i] = c.charCodeAt(0)));
    void view;
    globalThis.fetch = vi.fn(async () => new Response(wav.buffer, { status: 200 })) as unknown as typeof fetch;

    const task = await makeProvider().submitTask(REQ);
    expect(task.initialStatus?.status).toBe('success');
    expect(task.initialStatus?.resultUrl).toMatch(/^data:audio\/wav;base64,/);
  });

  it('缺少 baseUrl 在构造期即报错（防误打云端）', () => {
    expect(() => new OpenAICompatibleProvider('x', { type: 'openai-compatible' } as never)).toThrow(
      /baseUrl is required/,
    );
  });
});

describe('openai-compatible 文生图适配器', () => {
  const IMG_REQ = {
    provider: 'gateway',
    taskType: 'text_to_image' as const,
    prompt: '一只在月光下奔跑的橘猫',
  };

  it('成功：POST /v1/images/generations，url 响应 → initialStatus=success', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return new Response(
        JSON.stringify({ data: [{ index: 0, url: 'https://cdn.example.com/img.png' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = makeProvider({ models: { text_to_image: 'dall-e-3' } });
    const task = await provider.submitTask(IMG_REQ);
    expect(task.initialStatus?.status).toBe('success');
    expect(task.initialStatus?.resultUrl).toBe('https://cdn.example.com/img.png');
    expect(calls[0]!.url).toBe('http://127.0.0.1:8000/v1/images/generations');
    expect(calls[0]!.body).toEqual({ model: 'dall-e-3', prompt: IMG_REQ.prompt, n: 1 });
  });

  it('b64_json 响应 → 转 data URL 填 initialStatus', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ index: 0, b64_json: 'QUJD' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const task = await makeProvider({ models: { text_to_image: 'm' } }).submitTask(IMG_REQ);
    expect(task.initialStatus?.status).toBe('success');
    expect(task.initialStatus?.resultUrl).toBe('data:image/png;base64,QUJD');
  });

  it('空 data / 无 url 无 b64_json → failed', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const task = await makeProvider({ models: { text_to_image: 'm' } }).submitTask(IMG_REQ);
    expect(task.initialStatus?.status).toBe('failed');
    expect(task.initialStatus?.errorCode).toBe('EMPTY_IMAGE');
  });

  it('HTTP 500 → failed，errorMessage 带服务端详情', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;

    const task = await makeProvider({ models: { text_to_image: 'm' } }).submitTask(IMG_REQ);
    expect(task.initialStatus?.status).toBe('failed');
    expect(task.initialStatus?.errorCode).toBe('HTTP_429');
    expect(task.initialStatus?.errorMessage).toContain('rate limited');
  });

  it('不支持的任务类型（如 text_to_video）直接抛错', async () => {
    await expect(
      makeProvider().submitTask({ ...REQ, taskType: 'text_to_video' as never }),
    ).rejects.toThrow(/仅支持 audio_tts \/ text_to_image/);
  });
});

describe('getCapabilities 按 models 动态派生', () => {
  it('只声明 audio_tts → 单音频模态', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps.taskTypes).toEqual(['audio_tts']);
    expect(caps.modalities).toEqual(['audio']);
    expect(caps.outputFormats).toEqual(['audio/mpeg']);
  });

  it('声明 audio_tts + text_to_image → 双模态', () => {
    const caps = makeProvider({ models: { audio_tts: 'tts-1', text_to_image: 'dall-e-3' } }).getCapabilities();
    expect(caps.taskTypes).toEqual(['audio_tts', 'text_to_image']);
    expect(caps.modalities).toEqual(['audio', 'image']);
    expect(caps.outputFormats).toEqual(['image/png']);
  });

  it('无 models 声明的存量本地 TTS 配置 → 兜底 audio_tts（不回归）', () => {
    const caps = makeProvider({ models: undefined }).getCapabilities();
    expect(caps.taskTypes).toEqual(['audio_tts']);
    expect(caps.modalities).toEqual(['audio']);
  });
});
