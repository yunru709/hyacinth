/**
 * 缓存命中率汇总口径单测（token 加权平均）。
 *
 * 锁定的口径争议：UI 原先只显示"最近一轮"，噪声大；改用平均值时又要避免
 * "各轮百分比算术平均"这个错误口径 —— 长上下文轮与短问答轮在成本上差几十倍，
 * 必须按 token 量加权（等价于"整会话命中占比"）。
 */
import { describe, it, expect } from 'vitest';
import { averageHitRate } from './cache-rate.js';
import type { CacheTurnRecord } from './turn-state.js';

const rec = (hitTokens: number, missTokens: number, turn = 1): CacheTurnRecord => ({
  turn,
  timestamp: '2026-09-16T00:00:00.000Z',
  inputTokens: hitTokens + missTokens,
  outputTokens: 0,
  hitTokens,
  missTokens,
  hitRate: hitTokens + missTokens > 0 ? Math.round((hitTokens / (hitTokens + missTokens)) * 10000) / 100 : 0,
});

describe('averageHitRate（token 加权平均）', () => {
  it('无记录 / 零 token → undefined（UI 显示 n/a，而不是伪造 0）', () => {
    expect(averageHitRate([])).toBeUndefined();
    expect(averageHitRate([rec(0, 0)])).toBeUndefined();
  });

  it('单轮 → 等于该轮命中率', () => {
    expect(averageHitRate([rec(900, 100)])).toBe(90);
  });

  it('加权：长上下文轮主导结果（而非两轮各占一半）', () => {
    // 第 1 轮：1000 token 全命中（100%）；第 2 轮：100000 token 全未命中（0%）
    // 算术平均 = 50%，加权平均 = 1000/101000 ≈ 0.99%
    expect(averageHitRate([rec(1000, 0, 1), rec(0, 100000, 2)])).toBe(1);
  });

  it('多轮稳定命中 → 等于共同命中率', () => {
    expect(averageHitRate([rec(800, 200, 1), rec(8000, 2000, 2)])).toBe(80);
  });

  it('保留 1 位小数（四舍五入）', () => {
    // 1/3 命中 ≈ 33.333% → 33.3
    expect(averageHitRate([rec(1, 2)])).toBe(33.3);
  });
});
