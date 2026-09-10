import { describe, it, expect, afterEach } from 'vitest';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import {
  injectContextConfigCenter,
  safetyThreshold,
  targetRatio,
  clusterBudgetRatio,
  zone5TailBudgetRatio,
  zone4BudgetRatio,
  maxCompressRounds,
  trimWindow,
} from './context-config.js';

function stubConfigCenter(values: Record<string, unknown>): RuntimeConfigCenter {
  return {
    get: (path: string) => values[path],
  } as unknown as RuntimeConfigCenter;
}

afterEach(() => {
  injectContextConfigCenter(null);
});

describe('context 配置出口', () => {
  it('未注入时回退硬编码默认值（与重构前一致）', () => {
    expect(safetyThreshold()).toBe(0.95);
    expect(targetRatio()).toBe(0.15);
    expect(clusterBudgetRatio()).toBe(0.7);
    expect(zone5TailBudgetRatio()).toBe(0.15);
    expect(zone4BudgetRatio()).toBe(0.5);
    expect(maxCompressRounds()).toBe(3);
    expect(trimWindow()).toBe(6);
  });

  it('注入后读取 context.* 配置', () => {
    injectContextConfigCenter(
      stubConfigCenter({
        'context.safetyThreshold': 0.9,
        'context.targetRatio': 0.1,
        'context.clusterBudgetRatio': 0.8,
        'context.zone5TailBudgetRatio': 0.2,
        'context.zone4BudgetRatio': 0.4,
        'context.maxCompressRounds': 5,
        'context.trimWindow': 10,
      }),
    );
    expect(safetyThreshold()).toBe(0.9);
    expect(targetRatio()).toBe(0.1);
    expect(clusterBudgetRatio()).toBe(0.8);
    expect(zone5TailBudgetRatio()).toBe(0.2);
    expect(zone4BudgetRatio()).toBe(0.4);
    expect(maxCompressRounds()).toBe(5);
    expect(trimWindow()).toBe(10);
  });

  it('部分键未配置时回退默认值', () => {
    injectContextConfigCenter(stubConfigCenter({ 'context.safetyThreshold': 0.85 }));
    expect(safetyThreshold()).toBe(0.85);
    expect(targetRatio()).toBe(0.15);
    expect(clusterBudgetRatio()).toBe(0.7);
  });

  it('get 抛异常时回退默认值（不炸压缩器）', () => {
    injectContextConfigCenter({
      get: () => {
        throw new Error('boom');
      },
    } as unknown as RuntimeConfigCenter);
    expect(safetyThreshold()).toBe(0.95);
    expect(trimWindow()).toBe(6);
  });
});

describe('CompressorOrchestrator 消费 context.* 配置（回归闸）', () => {
  it('未传 options 时构造参数走配置默认', async () => {
    const { CompressorOrchestrator } = await import('./compressor.js');
    // 最小 tokenizer/summarizer stub——构造器只存引用，不调用
    const tokenizer = { count: () => 0 } as never;
    const summarizer = {} as never;

    injectContextConfigCenter(
      stubConfigCenter({
        'context.safetyThreshold': 0.9,
        'context.targetRatio': 0.1,
        'context.maxCompressRounds': 4,
        'context.trimWindow': 8,
      }),
    );
    const c = new CompressorOrchestrator(tokenizer, summarizer, 100_000);
    expect((c as unknown as { safetyThreshold: number }).safetyThreshold).toBe(0.9);
    expect((c as unknown as { targetRatio: number }).targetRatio).toBe(0.1);
    expect((c as unknown as { maxRounds: number }).maxRounds).toBe(4);
    expect((c as unknown as { trimWindow: number }).trimWindow).toBe(8);
  });

  it('显式 options 优先于配置（保持既有语义）', async () => {
    const { CompressorOrchestrator } = await import('./compressor.js');
    const tokenizer = { count: () => 0 } as never;
    const summarizer = {} as never;

    injectContextConfigCenter(
      stubConfigCenter({ 'context.maxCompressRounds': 4, 'context.trimWindow': 8 }),
    );
    const c = new CompressorOrchestrator(tokenizer, summarizer, 100_000, {
      maxRounds: 2,
      trimWindow: 3,
    });
    expect((c as unknown as { maxRounds: number }).maxRounds).toBe(2);
    expect((c as unknown as { trimWindow: number }).trimWindow).toBe(3);
  });
});
