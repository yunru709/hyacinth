import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalProvider, createLocalProvider } from './local.js';

describe('LocalProvider', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.LOCAL_BASE_URL;
    delete process.env.LOCAL_MODEL;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('creates with default values', () => {
    const provider = new LocalProvider();
    // 默认 baseUrl http://127.0.0.1:11434/v1 → backend=ollama；默认 model 来自 local-config
    expect(provider.getProviderType()).toBe('ollama');
    expect(provider.getModel()).toBe('llama3.2');
  });

  it('accepts custom baseUrl and model', () => {
    const provider = new LocalProvider({
      baseUrl: 'http://localhost:1234/v1',
      model: 'llama-3.2-3b-q4',
    });
    expect(provider.getModel()).toBe('llama-3.2-3b-q4');
  });

  it('reads model from LOCAL_MODEL env var', () => {
    process.env.LOCAL_MODEL = 'deepseek-r1-7b';
    const provider = new LocalProvider();
    expect(provider.getModel()).toBe('deepseek-r1-7b');
  });

  it('reads baseUrl from LOCAL_BASE_URL env var', () => {
    process.env.LOCAL_BASE_URL = 'http://192.168.1.100:8080/v1';
    const provider = new LocalProvider();
    // 8080 端口不含 :11434 → backend=llamacpp
    expect(provider.getProviderType()).toBe('llamacpp');
  });

  it('setModel changes model at runtime', () => {
    const provider = new LocalProvider({ model: 'default' });
    expect(provider.getModel()).toBe('default');
    provider.setModel('qwen2.5-coder-14b');
    expect(provider.getModel()).toBe('qwen2.5-coder-14b');
  });

  it('factory function creates provider', () => {
    const provider = createLocalProvider({ model: 'test' });
    expect(provider).toBeInstanceOf(LocalProvider);
    expect(provider.getModel()).toBe('test');
  });

  it('satisfies the Provider interface', () => {
    const provider = new LocalProvider();
    expect(typeof provider.createStream).toBe('function');
    expect(typeof provider.getProviderType).toBe('function');
    expect(typeof provider.getModel).toBe('function');
  });

  it('throws friendly error on connection refused', async () => {
    // Point at a port nothing is listening on
    const provider = new LocalProvider({
      baseUrl: 'http://localhost:18799/v1',
      model: 'test',
    });

    const messages = [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }];

    await expect(async () => {
      for await (const _ of provider.createStream(messages)) {
        // should throw before yielding
      }
    }).rejects.toThrow(/Cannot connect to local model/i);
  }, 10000);
});