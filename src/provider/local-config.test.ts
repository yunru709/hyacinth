import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import {
  injectConfigCenter,
  getOllamaEndpoints,
  getLocalProcessConfig,
  getLocalProviderConfigLoader,
  detectLocalBackend,
  fetchOllamaModels,
  LLAMACPP_DEFAULT_PORT,
} from './local-config.js';

/** 构造最小 RuntimeConfigCenter 桩（只需 get(dot-path)） */
function stubConfigCenter(values: Record<string, unknown>): RuntimeConfigCenter {
  return {
    get: (path: string) => values[path],
  } as unknown as RuntimeConfigCenter;
}

afterEach(() => {
  // 还原注入，避免污染同进程其他测试
  injectConfigCenter(null as unknown as RuntimeConfigCenter);
});

describe('getOllamaEndpoints', () => {
  it('未注入 configCenter 时使用硬编码默认值', () => {
    const ep = getOllamaEndpoints();
    expect(ep.port).toBe(11434);
    expect(ep.apiBase).toBe('http://127.0.0.1:11434');
    expect(ep.v1Base).toBe('http://127.0.0.1:11434/v1');
    expect(ep.healthUrl).toBe('http://127.0.0.1:11434/api/tags');
  });

  it('仅配置 local.port 也生效（回归：旧实现会整包丢弃 port-only 配置）', () => {
    injectConfigCenter(stubConfigCenter({ 'local.port': 11500 }));
    const ep = getOllamaEndpoints();
    expect(ep.port).toBe(11500);
    expect(ep.apiBase).toBe('http://127.0.0.1:11500');
    expect(ep.healthUrl).toBe('http://127.0.0.1:11500/api/tags');
  });

  it('provider.local.* 覆盖 local.*（运行时覆盖优先）', () => {
    injectConfigCenter(
      stubConfigCenter({ 'provider.local.port': 11600, 'local.port': 11500 }),
    );
    expect(getOllamaEndpoints().port).toBe(11600);
  });

  it('baseUrl 的 host 覆盖默认 127.0.0.1（局域网部署）', () => {
    injectConfigCenter(
      stubConfigCenter({ 'local.baseUrl': 'http://192.168.1.8:11434/v1', 'local.port': 11434 }),
    );
    const ep = getOllamaEndpoints();
    expect(ep.apiBase).toBe('http://192.168.1.8:11434');
    expect(ep.v1Base).toBe('http://192.168.1.8:11434/v1');
  });

  it('非法 baseUrl 不抛出，回退默认 host', () => {
    injectConfigCenter(stubConfigCenter({ 'local.baseUrl': '::not-a-url::' }));
    expect(getOllamaEndpoints().apiBase).toBe('http://127.0.0.1:11434');
  });
});

describe('getLocalProcessConfig', () => {
  it('未配置时返回与 runtime/defaults.ts 一致的默认值', () => {
    const cfg = getLocalProcessConfig();
    expect(cfg).toEqual({
      restartDelayMs: 3000,
      intervalMs: 5000,
      timeoutMs: 5000,
      maxRetries: 6,
      startupTimeoutMs: 120000,
    });
  });

  it('provider.local.healthCheck.* 逐项覆盖', () => {
    injectConfigCenter(
      stubConfigCenter({
        'provider.local.healthCheck.intervalMs': 8000,
        'provider.local.healthCheck.startupTimeoutMs': 60000,
      }),
    );
    const cfg = getLocalProcessConfig();
    expect(cfg.intervalMs).toBe(8000);
    expect(cfg.startupTimeoutMs).toBe(60000);
    // 未覆盖项保持默认
    expect(cfg.maxRetries).toBe(6);
    expect(cfg.timeoutMs).toBe(5000);
  });
});

describe('getLocalProviderConfigLoader', () => {
  it('port-only 配置不再被整包丢弃', () => {
    injectConfigCenter(stubConfigCenter({ 'local.port': 11500 }));
    const cfg = getLocalProviderConfigLoader();
    expect(cfg.port).toBe(11500);
    // 其余字段回退默认值
    expect(cfg.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(cfg.defaultModel).toBe('llama3.2');
  });

  it('provider.local.model 映射到 defaultModel', () => {
    injectConfigCenter(stubConfigCenter({ 'provider.local.model': 'qwen3:8b' }));
    expect(getLocalProviderConfigLoader().defaultModel).toBe('qwen3:8b');
  });

  it('maxOutputTokens 旧键名 maxTokens 向后兼容', () => {
    injectConfigCenter(stubConfigCenter({ 'local.maxTokens': 2048 }));
    expect(getLocalProviderConfigLoader().maxOutputTokens).toBe(2048);
  });
});

describe('detectLocalBackend / fetchOllamaModels 走配置端口', () => {
  it('在 local.port 指定的端口上探测到 ollama', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen3:8b' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    try {
      injectConfigCenter(stubConfigCenter({ 'local.port': port }));
      const detected = await detectLocalBackend();
      expect(detected).not.toBeNull();
      expect(detected?.backend).toBe('ollama');
      expect(detected?.port).toBe(port);
      expect(detected?.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);

      const models = await fetchOllamaModels();
      expect(models).toContain('llama3.2:latest');
      expect(models).toContain('qwen3:8b');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('llamacpp 默认端口常量为 8080', () => {
    expect(LLAMACPP_DEFAULT_PORT).toBe(8080);
  });
});
