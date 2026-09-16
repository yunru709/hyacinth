/**
 * usage 缓存字段探测单测。
 *
 * 锁定的真实事故：`usage` 里缓存字段名因厂商而异，历史实现只认 DeepSeek 官方字段名
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` → 其他厂商（OpenAI 系
 * `prompt_tokens_details.cached_tokens`、部分代理 `cached_tokens` / `cache_read_input_tokens`）
 * 一律取不到 → TUI 持续 `Cache: n/a`。
 */
import { describe, it, expect } from 'vitest';
import { extractCacheUsage } from './usage-cache.js';

describe('extractCacheUsage（按候选字段名探测）', () => {
  it('DeepSeek 官方成对字段 → 原样采用（最精确）', () => {
    const u = { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 };
    expect(extractCacheUsage(u)).toEqual({ hit: 900, miss: 100 });
  });

  it('OpenAI 系 prompt_tokens_details.cached_tokens → miss 由总输入推导', () => {
    const u = { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 640 } };
    expect(extractCacheUsage(u)).toEqual({ hit: 640, miss: 360 });
  });

  it('直接字段 cached_tokens（部分代理）', () => {
    expect(extractCacheUsage({ prompt_tokens: 500, cached_tokens: 125 })).toEqual({ hit: 125, miss: 375 });
  });

  it('Anthropic 风格命名在兼容层的复用：cache_read_input_tokens / cache_hit_tokens', () => {
    expect(extractCacheUsage({ prompt_tokens: 200, cache_read_input_tokens: 150 })).toEqual({ hit: 150, miss: 50 });
    expect(extractCacheUsage({ prompt_tokens: 200, cache_hit_tokens: 50 })).toEqual({ hit: 50, miss: 150 });
  });

  it('usage 里没有 prompt_tokens 时用入参兜底', () => {
    expect(extractCacheUsage({ prompt_tokens_details: { cached_tokens: 30 } }, 100)).toEqual({ hit: 30, miss: 70 });
  });

  it('命中量大于总输入（厂商口径不一致）→ miss 夹到 0，不产出负数', () => {
    expect(extractCacheUsage({ prompt_tokens: 100, cached_tokens: 150 })).toEqual({ hit: 150, miss: 0 });
  });

  it('字段缺失 / 非法值 → undefined（宁可不显示，也不显示错值）', () => {
    expect(extractCacheUsage({ prompt_tokens: 100 })).toBeUndefined();
    expect(extractCacheUsage({ prompt_tokens: 100, cached_tokens: 'many' })).toBeUndefined();
    // 只有 hit 字段、又拿不到 prompt_tokens → 无从推导 miss，宁可不显示
    expect(extractCacheUsage({ prompt_cache_hit_tokens: 50 })).toBeUndefined();
    // 只有 hit、但有 prompt_tokens → 可推导 miss（合法路径）
    expect(extractCacheUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 50 })).toEqual({ hit: 50, miss: 50 });
    expect(extractCacheUsage({ prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50 })).toEqual({ hit: 50, miss: 50 }); // 成对时无需 prompt_tokens
  });

  it('非对象输入 → undefined（防御）', () => {
    expect(extractCacheUsage(undefined)).toBeUndefined();
    expect(extractCacheUsage(null)).toBeUndefined();
    expect(extractCacheUsage('usage')).toBeUndefined();
  });
});
