import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

const DARK_TEXT = '#E8E3D5';
const LIGHT_TEXT = '#1E1E1E';
const XTERM_LEVELS = [0, 95, 135, 175, 215, 255] as const;

type RGB = readonly [number, number, number];
type Painter = (text: string) => string;
type StateKey = 'success' | 'warning' | 'error' | 'info';

/**
 * 语义键与 themes.json / theme.css 的同名键一一对应。
 * 顺序不影响行为，但和 CSS 里保持一致，方便两端对照排查。
 */
type SemanticKey =
  | 'background'
  | 'foreground'
  | 'card'
  | 'card-foreground'
  | 'popover'
  | 'popover-foreground'
  | 'primary'
  | 'primary-foreground'
  | 'accent'
  | 'accent-foreground'
  | 'muted'
  | 'muted-foreground'
  | 'border'
  | 'input'
  | 'ring';

export interface ThemeDefinition {
  readonly id: string;
  readonly label: string;
  readonly dark: boolean;
  readonly palette: Readonly<Record<string, string>>;
  readonly semantic: Readonly<Record<SemanticKey, string>>;
  readonly state: Readonly<Record<StateKey, string>>;
}

interface ThemesFile {
  readonly version: number;
  readonly root: ThemeDefinition;
  readonly themes: readonly ThemeDefinition[];
}

// ── 亮/暗探测（保留原有逻辑，未设置 AGENT_THEME 时的默认行为不变）────────

function channelToSrgb(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminanceRgb(r: number, g: number, b: number): number {
  return 0.2126 * channelToSrgb(r) + 0.7152 * channelToSrgb(g) + 0.0722 * channelToSrgb(b);
}

function relativeLuminanceHex(hex: string): number {
  const [r, g, b] = parseColor(hex, [0, 0, 0]);
  return relativeLuminanceRgb(r, g, b);
}

function contrastRatio(background: number, foregroundHex: string): number {
  const foreground = relativeLuminanceHex(foregroundHex);
  const lighter = Math.max(background, foreground);
  const darker = Math.min(background, foreground);
  return (lighter + 0.05) / (darker + 0.05);
}

function pickHigherContrastText(r: number, g: number, b: number): boolean {
  const background = relativeLuminanceRgb(r, g, b);
  return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT);
}

function isLightBackground(): boolean {
  const explicit = process.env.AGENT_THEME;
  if (explicit === 'light') return true;
  if (explicit === 'dark') return false;

  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg && colorfgbg.length <= 64) {
    const sep = colorfgbg.lastIndexOf(';');
    const bg = Number.parseInt(sep >= 0 ? colorfgbg.slice(sep + 1) : colorfgbg, 10);
    if (bg >= 0 && bg <= 255) {
      if (bg <= 15) return bg === 7 || bg === 15;
      if (bg >= 232) return bg >= 244;
      const cubeIndex = bg - 16;
      const bVal = XTERM_LEVELS[cubeIndex % 6];
      const gVal = XTERM_LEVELS[Math.floor(cubeIndex / 6) % 6];
      const rVal = XTERM_LEVELS[Math.floor(cubeIndex / 36)];
      return pickHigherContrastText(rVal, gVal, bVal);
    }
  }
  return false;
}

// ── 颜色工具 ────────────────────────────────────────────────────────────

/**
 * 解析 #rgb / #rrggbb / rgb() / rgba()。
 * 解析不了就返回 fallback 而不是抛错：这些值来自 themes.json，
 * 生成器已经校验过；万一被人手改成怪值，终端也不该因此起不来。
 */
function parseColor(value: string, fallback: RGB): RGB {
  const text = value.trim().toLowerCase();

  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (hex.length === 3) {
      const expand = (c: string) => Number.parseInt(c + c, 16);
      const r = expand(hex[0]);
      const g = expand(hex[1]);
      const b = expand(hex[2]);
      if ([r, g, b].every((n) => Number.isFinite(n))) return [r, g, b];
      return fallback;
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every((n) => Number.isFinite(n))) return [r, g, b];
    }
    return fallback;
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [clampChannel(parts[0]), clampChannel(parts[1]), clampChannel(parts[2])];
    }
  }
  return fallback;
}

function alphaOf(value: string): number {
  const fn = /^rgba\(([^)]+)\)$/.exec(value.trim().toLowerCase());
  if (!fn) return 1;
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  const alpha = parts[3];
  return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function formatHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((c) => clampChannel(c).toString(16).padStart(2, '0')).join('')}`;
}

/** src 叠在 dst 上（alpha 合成）；终端没有透明度，只能摊平成实色 */
function blend(dst: RGB, src: RGB, alpha: number): RGB {
  return [
    clampChannel(src[0] * alpha + dst[0] * (1 - alpha)),
    clampChannel(src[1] * alpha + dst[1] * (1 - alpha)),
    clampChannel(src[2] * alpha + dst[2] * (1 - alpha)),
  ];
}

/**
 * 把可能带 alpha 的颜色摊平成实色。
 *
 * 为什么必须摊平：glass 主题的背景 / 卡片 / 边框都是 rgba（毛玻璃），
 * 浏览器里靠下层叠出观感；chalk 的 bgHex 只接受不透明色，直接丢 rgba
 * 会解析成黑色。这里按「白底或黑底」这个最保守的假设合成，
 * 至少保证亮主题不会变成黑块。
 */
function toSolid(value: string, backdrop: RGB): RGB {
  const rgb = parseColor(value, backdrop);
  const alpha = alphaOf(value);
  return alpha >= 1 ? rgb : blend(backdrop, rgb, alpha);
}

function mixHex(base: string, overlay: string, alpha: number): string {
  return formatHex(blend(parseColor(base, [0, 0, 0]), parseColor(overlay, [0, 0, 0]), alpha));
}

// ── 256 色降级 ──────────────────────────────────────────────────────────

const ANSI16_RGB: readonly RGB[] = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

/** xterm-256 索引 → RGB（16 基础色 / 6×6×6 色立方 / 24 级灰阶） */
export function xterm256ToRgb(index: number): RGB {
  const i = Math.min(255, Math.max(0, Math.trunc(Number.isFinite(index) ? index : 0)));
  if (i < 16) return ANSI16_RGB[i];
  if (i < 232) {
    const n = i - 16;
    return [XTERM_LEVELS[Math.floor(n / 36)], XTERM_LEVELS[Math.floor(n / 6) % 6], XTERM_LEVELS[n % 6]];
  }
  const gray = 8 + (i - 232) * 10;
  return [gray, gray, gray];
}

function nearestXtermLevel(value: number): number {
  let best = 0;
  for (let i = 1; i < XTERM_LEVELS.length; i++) {
    if (Math.abs(value - XTERM_LEVELS[i]) < Math.abs(value - XTERM_LEVELS[best])) best = i;
  }
  return best;
}

function squaredDistance(a: RGB, b: RGB): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/**
 * RGB → xterm-256 索引。
 *
 * 只找「色立方最近点」是不够的：灰阶 232-255 每隔 10 就有一个点，
 * 比色立方的 0/95/135/175/215/255 密得多，深灰浅灰若强行吸到立方
 * 会出现 95→135 的大跳变（终端里看就是「灰色断层」）。所以两套候选
 * 都算出来，按欧氏距离取更近的那个。
 */
export function rgbToXterm256(r: number, g: number, b: number): number {
  const red = clampChannel(r);
  const green = clampChannel(g);
  const blue = clampChannel(b);

  const cube = 16 + 36 * nearestXtermLevel(red) + 6 * nearestXtermLevel(green) + nearestXtermLevel(blue);
  const grayAverage = Math.round((red + green + blue) / 3);
  const grayOffset = Math.min(23, Math.max(0, Math.round((grayAverage - 8) / 10)));
  const gray = 232 + grayOffset;

  const target: RGB = [red, green, blue];
  return squaredDistance(xterm256ToRgb(gray), target) < squaredDistance(xterm256ToRgb(cube), target)
    ? gray
    : cube;
}

function rgbToAnsi16(r: number, g: number, b: number): number {
  const target: RGB = [clampChannel(r), clampChannel(g), clampChannel(b)];
  let best = 0;
  for (let i = 1; i < ANSI16_RGB.length; i++) {
    if (squaredDistance(ANSI16_RGB[i], target) < squaredDistance(ANSI16_RGB[best], target)) best = i;
  }
  return best;
}

// chalk 的命名色与 ANSI 索引对齐（8-15 为高亮档）
const ANSI16_FG = [
  chalk.black,
  chalk.red,
  chalk.green,
  chalk.yellow,
  chalk.blue,
  chalk.magenta,
  chalk.cyan,
  chalk.white,
  chalk.blackBright,
  chalk.redBright,
  chalk.greenBright,
  chalk.yellowBright,
  chalk.blueBright,
  chalk.magentaBright,
  chalk.cyanBright,
  chalk.whiteBright,
] as const;

const ANSI16_BG = [
  chalk.bgBlack,
  chalk.bgRed,
  chalk.bgGreen,
  chalk.bgYellow,
  chalk.bgBlue,
  chalk.bgMagenta,
  chalk.bgCyan,
  chalk.bgWhite,
  chalk.bgBlackBright,
  chalk.bgRedBright,
  chalk.bgGreenBright,
  chalk.bgYellowBright,
  chalk.bgBlueBright,
  chalk.bgMagentaBright,
  chalk.bgCyanBright,
  chalk.bgWhiteBright,
] as const;

/**
 * 三层输出：truecolor → 256 → 16 → 无色。
 * 这里刻意不直接用 chalk.hex：chalk 自己也会降级，但用的是它内置
 * 的量化表；项目要的是与 XTERM_LEVELS 同一套算法（也便于单测），
 * 所以显式判断 chalk.level 再选通道。
 */
function paint(rgb: RGB, text: string, background: boolean): string {
  const level = chalk.level;
  if (level <= 0) return text;

  const [r, g, b] = rgb;
  if (level >= 3) return background ? chalk.bgRgb(r, g, b)(text) : chalk.rgb(r, g, b)(text);
  if (level === 2) {
    const index = rgbToXterm256(r, g, b);
    return background ? chalk.bgAnsi256(index)(text) : chalk.ansi256(index)(text);
  }
  const index = rgbToAnsi16(r, g, b);
  return (background ? ANSI16_BG[index] : ANSI16_FG[index])(text);
}

const fg = (hex: string): Painter => {
  const rgb = parseColor(hex, [255, 255, 255]);
  return (text) => paint(rgb, text, false);
};

const bg = (hex: string): Painter => {
  const rgb = parseColor(hex, [0, 0, 0]);
  return (text) => paint(rgb, text, true);
};

// ── 读主题数据 ──────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 两个候选路径，顺序即优先级：
 *   1. <同目录>/../webui/themes.json —— src/ui→src/webui、dist/ui→dist/webui
 *      （tsc 保持 rootDir 结构，所以这两处相对位置其实一样）
 *   2. <同目录>/../../src/webui/themes.json —— 从 dist 里跑、但 dist/webui
 *      还没被 scripts/copy-webui.cjs 拷过时（只 tsc 没 build 的源码树）兜底。
 * 实测：`tsc` 之后直接 node dist/index.js，dist/webui/ 是不存在的，
 * 只有完整 build 才会把 JSON 拷进去 —— 不做第二个候选就会读不到。
 */
const THEME_FILE_CANDIDATES = [
  resolve(HERE, '..', 'webui', 'themes.json'),
  resolve(HERE, '..', '..', 'src', 'webui', 'themes.json'),
];

function loadThemes(): ThemesFile | null {
  for (const file of THEME_FILE_CANDIDATES) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ThemesFile;
      if (parsed && Array.isArray(parsed.themes) && parsed.root) return parsed;
    } catch {
      // 读不到 / 不是 JSON：继续试下一个候选，最后回落旧硬编码色
    }
  }
  return null;
}

const THEME_DATA = loadThemes();

export interface TuiPalette {
  readonly background: string;
  readonly text: string;
  readonly dim: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly border: string;
  readonly userBg: string;
  readonly userText: string;
  readonly systemText: string;
  readonly toolPendingBg: string;
  readonly toolSuccessBg: string;
  readonly toolErrorBg: string;
  readonly toolTitle: string;
  readonly toolOutput: string;
  readonly quote: string;
  readonly quoteBorder: string;
  readonly thinking: string;
  readonly code: string;
  readonly codeBlock: string;
  readonly codeBorder: string;
  readonly link: string;
  readonly error: string;
  readonly success: string;
  readonly warning: string;
}

/**
 * 旧版硬编码配色，只作为 themes.json 读不到时的兜底。
 * 保留它是为了「数据文件缺失 ≠ 终端起不来」：分发时漏拷 JSON、
 * 或 CI 里只跑 tsc 没跑 copy-webui，都会命中这里。
 */
const LEGACY_DARK_PALETTE: TuiPalette = {
  // 旧配色没有「背景」这个令牌（终端不铺满底色）；兜底时用纯黑，
  // 不去编一个品牌色出来 —— 这是「假设的终端底色」，不是主题色。
  background: '#000000',
  text: '#E8E3D5',
  dim: '#7B7F87',
  accent: '#F6C453',
  accentSoft: '#F2A65A',
  border: '#3C414B',
  userBg: '#2B2F36',
  userText: '#F3EEE0',
  systemText: '#9BA3B2',
  toolPendingBg: '#1F2A2F',
  toolSuccessBg: '#1E2D23',
  toolErrorBg: '#2F1F1F',
  toolTitle: '#F6C453',
  toolOutput: '#E1DACB',
  quote: '#8CC8FF',
  quoteBorder: '#3B4D6B',
  thinking: '#8CC8FF',
  code: '#F0C987',
  codeBlock: '#1E232A',
  codeBorder: '#343A45',
  link: '#7DD3A5',
  error: '#F97066',
  success: '#7DD3A5',
  // 旧版 theme.warning 就是 accentSoft（见原 theme.ts 末尾），保持一致
  warning: '#F2A65A',
};

const LEGACY_LIGHT_PALETTE: TuiPalette = {
  background: '#FFFFFF',
  text: '#1E1E1E',
  dim: '#5B6472',
  accent: '#B45309',
  accentSoft: '#C2410C',
  border: '#5B6472',
  userBg: '#F3F0E8',
  userText: '#1E1E1E',
  systemText: '#4B5563',
  toolPendingBg: '#EFF6FF',
  toolSuccessBg: '#ECFDF5',
  toolErrorBg: '#FEF2F2',
  toolTitle: '#B45309',
  toolOutput: '#374151',
  quote: '#1D4ED8',
  quoteBorder: '#2563EB',
  thinking: '#1D4ED8',
  code: '#92400E',
  codeBlock: '#F9FAFB',
  codeBorder: '#92400E',
  link: '#047857',
  error: '#DC2626',
  success: '#047857',
  warning: '#C2410C',
};

// ── 主题 → TUI 调色板 ───────────────────────────────────────────────────

function resolveSemantic(def: ThemeDefinition, key: SemanticKey, backdrop: RGB): RGB {
  // 缺键时退回 foreground：themes.json 由生成器校验过，理论上不会缺；
  // 但 TUI 是入口程序，宁可少一层色，也不要因为一个 undefined 直接崩。
  const value = def.semantic[key] ?? def.semantic.foreground;
  // semantic 的值要么是调色板 key，要么是直接颜色（glass 的 rgba）
  const raw = value in def.palette ? def.palette[value] : value;
  return toSolid(raw, backdrop);
}

function buildTuiPalette(def: ThemeDefinition): TuiPalette {
  // 深色主题以纯黑为画布、亮色主题以纯白为画布 —— 半透明色的合成基准。
  // 不用「终端真实底色」是因为拿不到；黑白是最不会翻车的两极。
  const canvas: RGB = def.dark ? [0, 0, 0] : [255, 255, 255];
  const background = resolveSemantic(def, 'background', canvas);
  const pick = (key: SemanticKey): string => formatHex(resolveSemantic(def, key, background));
  const state = (key: StateKey): string => formatHex(toSolid(def.state[key], background));
  const backgroundHex = formatHex(background);

  return {
    background: backgroundHex,
    text: pick('foreground'),
    dim: pick('muted-foreground'),
    accent: pick('primary'),
    accentSoft: pick('accent'),
    border: pick('border'),
    userBg: pick('card'),
    userText: pick('foreground'),
    systemText: pick('muted-foreground'),
    toolPendingBg: pick('popover'),
    // 工具面板的「成功/失败底色」在 JSON 里没有对应令牌：CSS 里那是
    // 低饱和铺底，TUI 只能用状态色按比例混进背景，保证仍是背景系。
    toolSuccessBg: mixHex(backgroundHex, state('success'), 0.16),
    toolErrorBg: mixHex(backgroundHex, state('error'), 0.16),
    toolTitle: pick('primary'),
    toolOutput: pick('foreground'),
    quote: pick('primary'),
    quoteBorder: pick('border'),
    thinking: pick('accent'),
    code: pick('accent'),
    codeBlock: pick('popover'),
    codeBorder: pick('border'),
    link: pick('primary'),
    error: state('error'),
    success: state('success'),
    warning: state('warning'),
  };
}

function themeById(id: string): ThemeDefinition | undefined {
  return THEME_DATA?.themes.find((item) => item.id === id);
}

/** 可选主题 id 列表（顺序与 themes.json 一致）；数据文件缺失时为空数组 */
export const THEME_IDS: readonly string[] = THEME_DATA ? THEME_DATA.themes.map((item) => item.id) : [];

export function getThemeDefinition(id: string): ThemeDefinition | undefined {
  return themeById(id);
}

function detectFallbackId(): 'light' | 'dark' {
  return isLightBackground() ? 'light' : 'dark';
}

/**
 * 主题解析优先级：
 *   1. AGENT_THEME 命中 themes.json 里的 id（含 light / dark 这两个已有 id）→ 用它
 *   2. AGENT_THEME 未设置或不认识 → 保留旧的 COLORFGBG + 亮度判定，
 *      再映射到同名的 light / dark 主题
 *
 * 为什么不给未知值报错：AGENT_THEME 是通用环境变量名，别的工具也可能设；
 * 敲错一个字母就让终端起不来，代价比「静默回落」大得多。
 */
function resolveActiveTheme(): { id: string; def: ThemeDefinition | null } {
  const requested = (process.env.AGENT_THEME ?? '').trim().toLowerCase();
  const hit = requested ? themeById(requested) : undefined;
  if (hit) return { id: hit.id, def: hit };

  const fallbackId = detectFallbackId();
  const matched = themeById(fallbackId);
  return { id: matched?.id ?? fallbackId, def: matched ?? null };
}

const active = resolveActiveTheme();

/** 当前生效的主题 id（AGENT_THEME=hyacinth 时就是 'hyacinth'） */
export const activeThemeId = active.id;

/** 当前是否亮色背景。以前靠探测得出，现在优先跟随主题自带的 dark 标记 */
export const lightMode = active.def ? !active.def.dark : isLightBackground();

const darkDefinition = themeById('dark');
const lightDefinition = themeById('light');

export const darkPalette: TuiPalette = darkDefinition ? buildTuiPalette(darkDefinition) : LEGACY_DARK_PALETTE;
export const lightPalette: TuiPalette = lightDefinition ? buildTuiPalette(lightDefinition) : LEGACY_LIGHT_PALETTE;

export const palette: TuiPalette = active.def ? buildTuiPalette(active.def) : lightMode ? lightPalette : darkPalette;

function highlightCode(code: string): string[] {
  return code.split('\n').map((line) => fg(palette.code)(line));
}

export const theme = {
  fg: fg(palette.text),
  assistantText: (text: string) => text,
  /** say 交付块（模型的"嘴"）—— 与普通 assistant 文本区分，用强调色 */
  delivered: fg(palette.accent),
  dim: fg(palette.dim),
  thinking: fg(palette.thinking),
  accent: fg(palette.accent),
  accentSoft: fg(palette.accentSoft),
  success: fg(palette.success),
  error: fg(palette.error),
  warning: fg(palette.warning),
  header: (text: string) => chalk.bold(fg(palette.accent)(text)),
  system: fg(palette.systemText),
  userBg: bg(palette.userBg),
  userText: fg(palette.userText),
  toolTitle: fg(palette.toolTitle),
  toolOutput: fg(palette.toolOutput),
  toolPendingBg: bg(palette.toolPendingBg),
  toolSuccessBg: bg(palette.toolSuccessBg),
  toolErrorBg: bg(palette.toolErrorBg),
  border: fg(palette.border),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  errorBright: fg(palette.error),
  // 以下三个是本次新增（不改旧键）：让「语义色全量」在 TUI 侧可达，
  // 以后写新组件不必再回来改 theme.ts。
  background: bg(palette.background),
  primary: fg(palette.accent),
  muted: fg(palette.dim),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(fg(palette.accent)(text)),
  link: (text) => fg(palette.link)(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => fg(palette.code)(text),
  codeBlock: (text) => fg(palette.code)(text),
  codeBlockBorder: (text) => fg(palette.codeBorder)(text),
  quote: (text) => fg(palette.quote)(text),
  quoteBorder: (text) => fg(palette.quoteBorder)(text),
  hr: (text) => fg(palette.border)(text),
  listBullet: (text) => fg(palette.accentSoft)(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  highlightCode,
};

const baseSelectListTheme: SelectListTheme = {
  selectedPrefix: (text) => fg(palette.accent)(text),
  selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
  description: (text) => fg(palette.dim)(text),
  scrollInfo: (text) => fg(palette.dim)(text),
  noMatch: (text) => fg(palette.dim)(text),
};

export const selectListTheme: SelectListTheme = baseSelectListTheme;

export const editorTheme: EditorTheme = {
  borderColor: (text) => fg(palette.border)(text),
  selectList: selectListTheme,
};
