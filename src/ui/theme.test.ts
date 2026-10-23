/**
 * theme.test.ts — 主题数据层 + TUI 取色
 *
 * 两个风险点：
 *   ① themes.json 是「两端唯一真源」。它少一套主题 / 少一个语义键，
 *      表现不是编译错误，而是某套主题在终端里变成默认色（或 var() 解析
 *      不出值 → 声明整条失效）。这种退化只能靠测试兜。
 *   ② TUI 的最后一道降级是 256 色。量化函数一旦越界（返回 256+），
 *      chalk 会直接抛「Invalid ANSI color」，整个终端起不来；
 *      而灰阶单调性决定深灰是不是会突然跳到浅灰（肉眼可见的断层）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rgbToXterm256, xterm256ToRgb } from './theme.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface ThemeJson {
  version: number;
  root: ThemeEntry;
  themes: ThemeEntry[];
}

interface ThemeEntry {
  id: string;
  label: string;
  dark: boolean;
  palette: Record<string, string>;
  semantic: Record<string, string>;
  state: Record<string, string>;
}

const themesJson = JSON.parse(
  readFileSync(resolve(HERE, '..', 'webui', 'themes.json'), 'utf8'),
) as ThemeJson;

// 与改造前 theme.css 里的 12 个 html[data-theme] 块逐一对应，
// 后 8 套（amber…nord）是第二批新增，顺序与 themes.json 的 themes[] 一致。
// 写死而不是从 JSON 里自洽推导：防止「JSON 里只剩 3 套」这种漂移也测试通过。
const EXPECTED_IDS = [
  'dark',
  'glass',
  'ink',
  'rainy',
  'hyacinth',
  'light',
  'mono',
  'cyber',
  'paper',
  'terminal',
  'glacier',
  'celadon',
  'amber',
  'abyss',
  'moss',
  'sakura',
  'vapor',
  'contrast',
  'daylight',
  'nord',
];

const SEMANTIC_KEYS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'accent',
  'accent-foreground',
  'muted',
  'muted-foreground',
  'border',
  'input',
  'ring',
];

const STATE_KEYS = ['success', 'warning', 'error', 'info'];
const PALETTE_REF = /^(neutral|primary|accent)-\d+$/;

function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

describe('themes.json 数据完整性', () => {
  it('覆盖 20 套主题，且每套语义键齐全、引用都能落到调色板', () => {
    expect(themesJson.version).toBe(1);
    expect(themesJson.root.id).toBe('root');

    const ids = themesJson.themes.map((t) => t.id);
    expect(ids).toEqual(EXPECTED_IDS);
    expect(new Set(ids).size).toBe(ids.length);

    for (const theme of [themesJson.root, ...themesJson.themes]) {
      expect(theme.label.length).toBeGreaterThan(0);
      expect(typeof theme.dark).toBe('boolean');

      // 调色板：三组齐全（每套至少要有 500 这一档，否则语义色没有落点）
      for (const group of ['neutral', 'primary', 'accent']) {
        expect(theme.palette[`${group}-500`], `${theme.id} 缺 ${group}-500`).toMatch(/^#[0-9a-f]{6}$/i);
      }

      for (const key of SEMANTIC_KEYS) {
        const value = theme.semantic[key];
        expect(value, `${theme.id} 缺语义键 ${key}`).toBeTruthy();
        if (PALETTE_REF.test(value)) {
          expect(theme.palette[value], `${theme.id}.${key} 引用了不存在的 ${value}`).toBeTruthy();
        } else {
          // 直接颜色（glass 的半透明卡片 / 背景）
          expect(value, `${theme.id}.${key} 既不是调色板引用也不是颜色`).toMatch(/^(#[0-9a-f]{3,8}|rgba?\()/i);
        }
      }

      for (const key of STATE_KEYS) {
        expect(theme.state[key], `${theme.id} 缺状态色 ${key}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe('256 色降级', () => {
  it('任意 RGB 都返回 0-255 的合法索引，且 xterm 索引都能还原成合法 RGB', () => {
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const index = rgbToXterm256(r, g, b);
          expect(Number.isInteger(index)).toBe(true);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThanOrEqual(255);
        }
      }
    }

    for (let index = 0; index <= 255; index++) {
      const [r, g, b] = xterm256ToRgb(index);
      for (const channel of [r, g, b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
        expect(Number.isInteger(channel)).toBe(true);
      }
    }
  });

  it('灰阶从暗到亮单调不回头，两端分别落在纯黑 / 纯白', () => {
    expect(rgbToXterm256(0, 0, 0)).toBe(16);
    expect(rgbToXterm256(255, 255, 255)).toBe(231);

    let previous = -1;
    for (let value = 0; value <= 255; value += 5) {
      const index = rgbToXterm256(value, value, value);
      const luminance = relativeLuminance(xterm256ToRgb(index));
      // 量化后的亮度不许倒退：倒退意味着深灰被吸到比浅灰更亮的档位，
      // 终端里就是一格一格的「灰色台阶」肉眼可见。
      expect(luminance, `gray ${value} → index ${index} 比上一档更暗`).toBeGreaterThanOrEqual(previous);
      previous = luminance;
    }
  });

  it('越界输入被夹紧，不产生非法索引', () => {
    expect(rgbToXterm256(-50, -50, -50)).toBe(16);
    expect(rgbToXterm256(999, 999, 999)).toBe(231);
  });

  it('输出层真的按 chalk.level 换通道（truecolor / 256 / 16 / 无色）', async () => {
    const chalk = (await import('chalk')).default;
    const { theme } = await import('./theme.js');
    const original = chalk.level;
    try {
      chalk.level = 3;
      expect(theme.accent('x')).toMatch(/^\u001B\[38;2;\d+;\d+;\d+m/);
      expect(theme.userBg('x')).toMatch(/^\u001B\[48;2;\d+;\d+;\d+m/);

      chalk.level = 2;
      expect(theme.accent('x')).toMatch(/^\u001B\[38;5;\d{1,3}m/);

      chalk.level = 1;
      expect(theme.accent('x')).toMatch(/^\u001B\[(3[0-7]|9[0-7])m/);

      chalk.level = 0;
      expect(theme.accent('x')).toBe('x');
    } finally {
      chalk.level = original;
    }
  });
});

describe('AGENT_THEME 解析优先级', () => {
  const originalTheme = process.env.AGENT_THEME;
  const originalColorFgBg = process.env.COLORFGBG;

  afterEach(() => {
    if (originalTheme === undefined) delete process.env.AGENT_THEME;
    else process.env.AGENT_THEME = originalTheme;
    if (originalColorFgBg === undefined) delete process.env.COLORFGBG;
    else process.env.COLORFGBG = originalColorFgBg;
    vi.resetModules();
  });

  it('具体主题 id 直接命中（不再走亮暗探测）', async () => {
    process.env.AGENT_THEME = 'glacier';
    process.env.COLORFGBG = '15;0'; // 若走探测会判成暗色
    vi.resetModules();
    const mod = await import('./theme.js');
    expect(mod.activeThemeId).toBe('glacier');
    // glacier 是冷白亮主题：lightMode 应由主题的 dark 标记决定，而不是探测
    expect(mod.lightMode).toBe(true);
  });

  it('AGENT_THEME=dark 映射到 dark 主题', async () => {
    process.env.AGENT_THEME = 'dark';
    vi.resetModules();
    const mod = await import('./theme.js');
    expect(mod.activeThemeId).toBe('dark');
    expect(mod.lightMode).toBe(false);
  });

  it('未设置时保留 COLORFGBG 探测（亮底 → light 主题）', async () => {
    delete process.env.AGENT_THEME;
    process.env.COLORFGBG = '0;15';
    vi.resetModules();
    const mod = await import('./theme.js');
    expect(mod.activeThemeId).toBe('light');
    expect(mod.lightMode).toBe(true);
  });
});
