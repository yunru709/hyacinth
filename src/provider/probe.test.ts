import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderProbe, DEFAULT_PROBE_CONFIG } from './probe.js';
import type { ProviderFactoryMeta } from './provider-meta.js';

function makeMeta(overrides: Partial<ProviderFactoryMeta> & { id: string }): ProviderFactoryMeta {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'test-model',
    envKey: 'X_API_KEY',
    ...rest,
  };
}

describe('ProviderProbe', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(status: number, body: unknown = {}) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }

  it('2xx → ok', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { id: 'chatcmpl-1' }));
    const probe = new ProviderProbe();
    const r = await probe.probe(makeMeta({ id: 'openai' }), 'sk-1234');
    expect(r.status).toBe('ok');
  });

  it('401/403 → unavailable（key 无效/欠费）', async () => {
    fetchMock.mockResolvedValue(mockResponse(401, { error: 'invalid api key' }));
    const probe = new ProviderProbe();
    expect((await probe.probe(makeMeta({ id: 'openai' }), 'sk-bad')).status).toBe('unavailable');
    fetchMock.mockResolvedValue(mockResponse(403, { error: 'quota' }));
    expect((await probe.probe(makeMeta({ id: 'deepseek' }), 'sk-bad')).status).toBe('unavailable');
  });

  it('404 → unavailable（模型不存在/端点不支持）', async () => {
    fetchMock.mockResolvedValue(mockResponse(404, { error: 'model not found' }));
    const probe = new ProviderProbe();
    expect((await probe.probe(makeMeta({ id: 'openai' }), 'sk-1234')).status).toBe('unavailable');
  });

  it('429/5xx → uncertain', async () => {
    fetchMock.mockResolvedValue(mockResponse(429, { error: 'rate limited' }));
    const probe = new ProviderProbe();
    expect((await probe.probe(makeMeta({ id: 'openai' }), 'sk-1234')).status).toBe('uncertain');
    fetchMock.mockResolvedValue(mockResponse(503, { error: 'overloaded' }));
    expect((await probe.probe(makeMeta({ id: 'openai' }), 'sk-1234')).status).toBe('uncertain');
  });

  it('网络错误 → uncertain', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const probe = new ProviderProbe();
    const r = await probe.probe(makeMeta({ id: 'openai' }), 'sk-1234');
    expect(r.status).toBe('uncertain');
  });

  it('超时 → uncertain 且 error=timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    const probe = new ProviderProbe();
    const r = await probe.probe(makeMeta({ id: 'openai' }), 'sk-1234');
    expect(r.status).toBe('uncertain');
    expect(r.error).toBe('timeout');
  });

  it('o 系 max_tokens 400 → max_completion_tokens 重试', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(400, { error: { message: 'max_tokens is not supported by this model' } }))
      .mockResolvedValueOnce(mockResponse(200, { id: 'chatcmpl-2' }));
    const probe = new ProviderProbe();
    const meta = makeMeta({ id: 'openai', defaultModel: 'gpt-5.5' });
    const r = await probe.probe(meta, 'sk-1234');
    expect(r.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
    expect(bodies[0].max_tokens).toBe(1);
    expect(bodies[1].max_completion_tokens).toBe(1);
  });

  it('anthropic 协议：baseUrl 无 /v1 → 拼 /v1/messages + x-api-key 头', async () => {
    fetchMock.mockResolvedValue(mockResponse(200));
    const probe = new ProviderProbe();
    const meta = makeMeta({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' });
    await probe.probe(meta, 'sk-ant-1234');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect((init as { headers: Record<string, string> }).headers['x-api-key']).toBe('sk-ant-1234');
  });

  it('anthropic 协议：baseUrl 已 /v1 → 拼 /messages（代理形态）', async () => {
    fetchMock.mockResolvedValue(mockResponse(200));
    const probe = new ProviderProbe();
    const meta = makeMeta({ id: 'qwen', baseUrl: 'https://gw.example.com/v1' });
    await probe.probe(meta, 'k');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://gw.example.com/v1/messages');
  });

  it('openai 协议：baseUrl 已 /chat/completions → 原样使用', async () => {
    fetchMock.mockResolvedValue(mockResponse(200));
    const probe = new ProviderProbe();
    const meta = makeMeta({ id: 'openai', baseUrl: 'https://gw.example.com/chat/completions' });
    await probe.probe(meta, 'sk-1234');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://gw.example.com/chat/completions');
  });

  it('gemini：走 generateContent REST（key 在 query）', async () => {
    fetchMock.mockResolvedValue(mockResponse(200));
    const probe = new ProviderProbe();
    const meta = makeMeta({
      id: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      defaultModel: 'gemini-2.5-pro',
    });
    await probe.probe(meta, 'gkey');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1beta/models/gemini-2.5-pro:generateContent?key=gkey');
    expect((init as { method: string }).method).toBe('POST');
  });

  it('ok 缓存期内不重复探测', async () => {
    fetchMock.mockResolvedValue(mockResponse(200));
    const probe = new ProviderProbe();
    const meta = makeMeta({ id: 'openai' });
    await probe.probe(meta, 'sk-1234');
    await probe.probe(meta, 'sk-1234');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('unavailable 冷却期内不重探', async () => {
    fetchMock.mockResolvedValue(mockResponse(401));
    const probe = new ProviderProbe();
    const meta = makeMeta({ id: 'openai' });
    await probe.probe(meta, 'sk-bad');
    await probe.probe(meta, 'sk-bad');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidate 后重新探测', async () => {
    fetchMock.mockResolvedValue(mockResponse(200));
    const probe = new ProviderProbe();
    const meta = makeMeta({ id: 'openai' });
    await probe.probe(meta, 'sk-1234');
    probe.invalidate(meta, 'sk-1234');
    await probe.probe(meta, 'sk-1234');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('并发去重：同候选只发一次请求', async () => {
    fetchMock.mockResolvedValue(mockResponse(200));
    const probe = new ProviderProbe();
    const meta = makeMeta({ id: 'openai' });
    await Promise.all([probe.probe(meta, 'sk-1234'), probe.probe(meta, 'sk-1234')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('默认配置符合内置默认值', () => {
    expect(DEFAULT_PROBE_CONFIG).toEqual({
      timeoutMs: 5000,
      cacheTtlMs: 60000,
      failureCooldownMs: 30000,
      uncertainCooldownMs: 15000,
    });
  });
});
