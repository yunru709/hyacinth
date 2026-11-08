/**
 * provider 加固守卫 · 第二组（2026-11-08 批次 1–5 的剩余项）。
 *
 * 第一组见 `hardening.guard.test.ts`（脱敏 / 文案 / 目录校验 / 纯函数 / gemini 开关）。
 * 这里补：探测缓存键的凭据泄露、reasoning 字段透传、local 三态的模型名、模型清单缓存失效。
 */
import { describe, it, expect } from 'vitest';
import { cacheKey } from './probe.js';
import { getModelInfo } from './catalog.js';
import { LocalProvider } from './local.js';
import { invalidateProviderModels, PROVIDER_MODELS } from '../setup/model-defaults.js';
import type { ProviderFactoryMeta } from './provider-meta.js';

const meta = {
  id: 'gw',
  baseUrl: 'https://gw.example.com/v1',
  defaultModel: 'm1',
} as ProviderFactoryMeta;

// ── P3-1：探测缓存键不得含凭据片段 ────────────────────────────────
describe('P3-1 探测缓存键不含 apiKey 原文', () => {
  it('键里不出现密钥任何片段（原实现拼的是后 4 位）', () => {
    const key = cacheKey(meta, 'sk-live-0123456789abcdef');

    expect(key).not.toContain('abcdef'); // 后 4 位
    expect(key).not.toContain('sk-live');
    // 但必须仍能区分"不同 key"——否则探测结果会跨 key 串用
    const other = cacheKey(meta, 'sk-live-ffffeeee11112222');
    expect(other).not.toBe(key);
  });

  it('空 key 有稳定占位（不产生 undefined 片段）', () => {
    const key = cacheKey(meta, '');
    expect(key).toContain('none');
    expect(key).not.toContain('undefined');
  });
});

// ── P2-1：reasoning 字段必须透传到 ModelInfo ──────────────────────
describe('P2-1 ModelInfo 必须带 reasoning（此前被静默丢弃）', () => {
  it('目录里存在的模型，reasoning 是布尔值而不是 undefined', () => {
    const info = getModelInfo('opencode' as never, 'deepseek-v4.1-flash');
    if (!info) return; // 该环境未安装此厂商的目录条目时跳过（不制造环境依赖）

    expect(typeof info.reasoning).toBe('boolean');
  });
});

// ── P2-4：local 三态不得把 'unknown' 当模型名 ─────────────────────
describe('P2-4 LocalProvider 的模型名回落到本地配置', () => {
  it('不传 model 时，不得得到 "unknown" 或空串', () => {
    const p = new LocalProvider({});
    const model = p.getModel();

    expect(model).toBeTruthy();
    expect(model).not.toBe('unknown');
  });
});

// ── P2-2：模型清单缓存可失效，且失效后仍可用 ──────────────────────
describe('P2-2 PROVIDER_MODELS 缓存可失效（防止与 modelCatalog 分叉）', () => {
  it('调用 invalidateProviderModels() 不抛，且之后读取仍能拿到清单', () => {
    expect(() => invalidateProviderModels()).not.toThrow();

    // 失效不应把结构弄坏：任意一个厂商都能重新算出来
    const keys = Object.keys(PROVIDER_MODELS);
    expect(keys.length).toBeGreaterThan(0);
  });
});
