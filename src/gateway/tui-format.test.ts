import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  visualWidth,
  truncateByVisualWidth,
  formatContextBar,
  detectLegacyTerminal,
} from './tui-format.js';

describe('visualWidth', () => {
  it('ASCII 每字符计 1', () => {
    expect(visualWidth('abc')).toBe(3);
  });

  it('CJK / 全角 / emoji 每字符计 2', () => {
    expect(visualWidth('中文')).toBe(4);
    expect(visualWidth('📦')).toBe(2);
    expect(visualWidth('a中')).toBe(3);
  });

  it('空串为 0', () => {
    expect(visualWidth('')).toBe(0);
  });
});

describe('truncateByVisualWidth', () => {
  it('不超宽时原样返回', () => {
    expect(truncateByVisualWidth('hello', 10)).toBe('hello');
  });

  it('超宽时按视觉宽度截断并加 ...', () => {
    const r = truncateByVisualWidth('中文测试文本很长', 10);
    expect(r).toMatch(/\.\.\.$/);
    // 截断后视觉宽度（含 ...）不超过上限 + 3
    expect(visualWidth(r)).toBeLessThanOrEqual(13);
  });
});

describe('formatContextBar', () => {
  it('低占比绿色，含百分比与 token 统计', () => {
    const s = formatContextBar(100, 1000);
    expect(s).toContain('Context:');
    expect(s).toContain('10%');
    expect(s).toContain('0K / 1K');
  });

  it('占比按 maxTokens 归一，超限钳制为 100%', () => {
    const s = formatContextBar(2000, 1000);
    expect(s).toContain('100%');
  });

  it('不同占比输出不同（填充量 + 百分比随之变化）', () => {
    const low = formatContextBar(100, 1000);   // 10%
    const high = formatContextBar(900, 1000);  // 90%
    expect(low).not.toBe(high);
    expect(low).toContain('10%');
    expect(high).toContain('90%');
  });
});

describe('detectLegacyTerminal', () => {
  const saved = { platform: process.platform, wt: process.env.WT_SESSION, tp: process.env.TERM_PROGRAM };

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', { value: saved.platform, configurable: true });
  });

  it('非 Windows 恒返回 false', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(detectLegacyTerminal()).toBe(false);
  });

  it('Windows 且无现代终端环境变量时返回 true（旧 conhost）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('WT_SESSION', undefined);
    vi.stubEnv('TERM_PROGRAM', undefined);
    expect(detectLegacyTerminal()).toBe(true);
  });

  it('Windows 有 WT_SESSION 时返回 false（现代终端）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('WT_SESSION', '1');
    vi.stubEnv('TERM_PROGRAM', undefined);
    expect(detectLegacyTerminal()).toBe(false);
  });
});
