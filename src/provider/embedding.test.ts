// embedding 供应商单测（stub 全局 fetch + 注入 ProviderConfigLoader，无网络）
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleEmbeddingProvider, getEmbeddingProvider } from './embedding.js';
import { ProviderConfigLoader, getProviderConfigLoader, __setProviderConfigLoaderForTest } from './config.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('OpenAICompatibleEmbeddingProvider', () => {
  function makeProvider(overrides: Record<string, unknown> = {}) {
    return new OpenAICompatibleEmbeddingProvider({
      providerType: 'my_gateway',
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'text-embedding-3-small',
      ...overrides,
    } as never);
  }

  it('成功：POST {baseUrl}/embeddings，body {model, input}，结果按 index 排序对齐', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0.2, 0.3] },
            { index: 0, embedding: [0.1, 0.2] },
          ],
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const r = await makeProvider().embed({ input: ['a', 'b'] });
    expect(calls[0]!.url).toBe('https://gateway.example.com/v1/embeddings');
    expect(calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'] });
    // 响应乱序 → 按 index 重排，与 input 对齐
    expect(r.embeddings).toEqual([
      [0.1, 0.2],
      [0.2, 0.3],
    ]);
    expect(r.model).toBe('text-embedding-3-small');
    expect(r.usage).toEqual({ promptTokens: 7, totalTokens: 7 });
  });

  it('字符串 input 归一为单元素数组；req.model 覆盖配置默认', async () => {
    const bodies: Array<{ model: string; input: unknown }> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { model: string; input: string[] };
      bodies.push(body);
      return new Response(
        JSON.stringify({ data: body.input.map((_, i) => ({ index: i, embedding: [i] })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const r = await makeProvider().embed({ input: 'hello', model: 'custom-embed' });
    expect(bodies[0]!.model).toBe('custom-embed');
    expect(bodies[0]!.input).toEqual(['hello']);
    expect(r.embeddings).toEqual([[0]]);
  });

  it('HTTP 错误 → throw 带状态码与详情', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('invalid api key', { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(makeProvider().embed({ input: 'x' })).rejects.toThrow(/401.*invalid api key/);
  });

  it('响应数量与请求不匹配 → throw', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    await expect(makeProvider().embed({ input: ['a', 'b'] })).rejects.toThrow(/数量不匹配/);
  });

  it('缺 apiKey / 缺 baseUrl → 构造期抛错', () => {
    expect(() =>
      new OpenAICompatibleEmbeddingProvider({ providerType: 'x', apiKey: '', baseUrl: 'http://x/v1', model: 'm' }),
    ).toThrow(/API key/);
    expect(() =>
      new OpenAICompatibleEmbeddingProvider({ providerType: 'x', apiKey: 'k', baseUrl: '', model: 'm' }),
    ).toThrow(/baseUrl/);
  });
});

describe('getEmbeddingProvider', () => {
  let tmpDir: string;
  let provFile: string;
  let prevLoader: ReturnType<typeof getProviderConfigLoader>;

  beforeAll(() => {
    prevLoader = getProviderConfigLoader(process.cwd()); // 初始化单例，afterAll 还原
  });
  afterAll(async () => {
    __setProviderConfigLoaderForTest(prevLoader);
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hyacinth-emb-'));
    provFile = join(tmpDir, 'providers.json');
  });

  async function declare(providers: Record<string, unknown>): Promise<void> {
    await writeFile(provFile, JSON.stringify({ providers }), 'utf-8');
    const loader = new ProviderConfigLoader(tmpDir, provFile);
    await loader.load();
    __setProviderConfigLoaderForTest(loader);
  }

  it('自动找第一个声明 embedding 能力的厂商并创建实例（模型来自能力声明）', async () => {
    await declare({
      my_gateway: {
        id: 'my_gateway',
        baseUrl: 'https://gateway.example.com/v1',
        defaultModel: 'gpt-4o',
        envKey: 'GATEWAY_API_KEY',
        capabilities: { embedding: { model: 'text-embedding-3-small' } },
      },
    });
    vi.stubEnv('GATEWAY_API_KEY', 'secret');

    const ep = getEmbeddingProvider();
    expect(ep).not.toBeNull();
    expect(ep!.providerType).toBe('my_gateway');

    const calls: Array<{ model: string }> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: { body?: string }) => {
      calls.push(JSON.parse(init?.body ?? '{}') as { model: string });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await ep!.embed({ input: 'hi' });
    expect(calls[0]!.model).toBe('text-embedding-3-small'); // 能力声明里的模型生效
  });

  it('指定 vendorId 路由', async () => {
    await declare({
      gw_a: {
        id: 'gw_a', baseUrl: 'https://a.example.com/v1', envKey: 'A_API_KEY',
        capabilities: { embedding: { model: 'm1' } },
      },
      gw_b: { id: 'gw_b', baseUrl: 'https://b.example.com/v1', envKey: 'B_API_KEY' },
    });
    vi.stubEnv('A_API_KEY', 'a');

    const ep = getEmbeddingProvider('gw_a');
    expect(ep).not.toBeNull();
    expect(ep!.providerType).toBe('gw_a');
  });

  it('厂商未声明 embedding 能力 → null', async () => {
    await declare({ gw: { id: 'gw', baseUrl: 'https://g.example.com/v1', envKey: 'G_API_KEY' } });
    expect(getEmbeddingProvider('gw')).toBeNull();
  });

  it('缺 API key → null（不构造实例）', async () => {
    await declare({
      gw: {
        id: 'gw', baseUrl: 'https://g.example.com/v1', envKey: 'G_API_KEY',
        capabilities: { embedding: { model: 'm' } },
      },
    });
    expect(getEmbeddingProvider('gw')).toBeNull();
  });

  it('loader 未初始化 → null（启动早期容错）', () => {
    __setProviderConfigLoaderForTest(undefined);
    expect(getEmbeddingProvider()).toBeNull();
  });
});
