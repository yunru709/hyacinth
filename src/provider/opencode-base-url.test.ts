import { describe, it, expect } from 'vitest';
import { isOpenCodeGoKey, resolveOpenCodeBaseUrl } from './compatible.js';

const ZEN = 'https://opencode.ai/zen/v1';
const GO = 'https://opencode.ai/inference/go/openai/v1';

describe('OpenCode Go 端点自动识别', () => {
  it('oc_sk_ 前缀识别为 Go 订阅密钥', () => {
    expect(isOpenCodeGoKey('oc_sk_abc')).toBe(true);
    expect(isOpenCodeGoKey('sk-abc')).toBe(false);
    expect(isOpenCodeGoKey(undefined)).toBe(false);
  });

  it('未配置 baseUrl + Go 密钥 → Go 端点', () => {
    expect(resolveOpenCodeBaseUrl(undefined, 'oc_sk_abc')).toBe(GO);
  });

  it('providers.json 残留 Zen 默认值 + Go 密钥 → 自动切 Go 端点', () => {
    expect(resolveOpenCodeBaseUrl(ZEN, 'oc_sk_abc')).toBe(GO);
  });

  it('Zen 密钥保持 Zen 端点', () => {
    expect(resolveOpenCodeBaseUrl(undefined, 'sk-abc')).toBe(ZEN);
    expect(resolveOpenCodeBaseUrl(ZEN, 'sk-abc')).toBe(ZEN);
  });

  it('自定义代理 baseUrl 不按密钥前缀改写', () => {
    expect(resolveOpenCodeBaseUrl('https://proxy.example.com/v1', 'oc_sk_abc')).toBe(
      'https://proxy.example.com/v1',
    );
  });
});
