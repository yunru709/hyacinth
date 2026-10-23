#!/usr/bin/env node
/**
 * gen-theme-css — 把 src/webui/themes.json 渲染成 src/webui/theme.css 的
 * GENERATED 区块（:root 兜底 + 每个 html[data-theme] 的颜色令牌）。
 *
 * 为什么是「只替换标记之间」而不是整份重写：
 * theme.css 里除了颜色还有一整套设计语言（字体 / 圆角 / 阴影 / 背景画 /
 * 气泡材质），那是手写的美术决策，跟 JSON 里的色值不是一个抽象层级。
 * 整份重写会把它们冲掉，所以用固定标记圈出生成区，标记之外原样保留。
 *
 * 为什么生成器不自己挑色 / 不补齐缺失主题：
 * 原 theme.css 的 12 套是设计师逐套定的，生成器一旦「顺手调和一下」
 * 就会让 WebUI 的观感和改动前对不上。这里的职责只有排版：
 * 值从 JSON 逐字取出，缺键直接报错退出，宁可失败也不静默变色。
 *
 * 用法：node scripts/gen-theme-css.cjs        （原地更新 theme.css）
 *       node scripts/gen-theme-css.cjs --check（只校验，不写盘；CI 可用来查漂移）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSON_FILE = path.join(ROOT, 'src', 'webui', 'themes.json');
const CSS_FILE = path.join(ROOT, 'src', 'webui', 'theme.css');

const BEGIN = '/* === GENERATED:BEGIN（由 scripts/gen-theme-css.cjs 生成，勿手改）=== */';
const END = '/* === GENERATED:END === */';

// 语义键的固定顺序：与旧 theme.css 逐行对照过，保持顺序能让 diff 里
// 「只是搬家」的行对得上，审查时一眼能看出有没有真的改色。
const SEMANTIC_ORDER = [
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

// 旧别名只保留原来就有的 13 个（原文件没有 --accent / --accent-foreground 别名，
// 这里也不加：app.css 是否用到是另一件事，生成器不扩大契约）。
const LEGACY_ALIASES = SEMANTIC_ORDER.filter((k) => k !== 'accent' && k !== 'accent-foreground');

const STATE_ORDER = ['success', 'warning', 'error', 'info'];

const PALETTE_GROUPS = [
  ['neutral', 'Neutral'],
  ['primary', 'Primary'],
  ['accent', 'Accent'],
];

// 前端分组用的三个桶。为什么在生成器里也要校验：
// groups 是「分区」而不是「标签」—— 三桶相加必须正好等于全部主题，
// 否则前端会漏渲染（新增主题没进任何桶）或渲染出重复卡片（同一 id 进了两桶）。
// 这种漂移不会让 CSS 变错，但会让主题选择器少一套，肉眼很难发现，所以宁可让 --check 失败。
const GROUP_KEYS = ['dark', 'light', 'special'];

function fail(msg) {
  console.error(`[gen-theme-css] ${msg}`);
  process.exit(1);
}

function readJson() {
  let raw;
  try {
    raw = fs.readFileSync(JSON_FILE, 'utf8');
  } catch (error) {
    fail(`读不到 ${path.relative(ROOT, JSON_FILE)}：${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${path.relative(ROOT, JSON_FILE)} 不是合法 JSON：${error.message}`);
  }
}

/** 校验结构；任何一处对不上就退出，避免生成出半套主题 */
function validate(data) {
  if (data.version !== 1) fail(`不支持的 themes.json version：${data.version}`);
  if (!data.root || !Array.isArray(data.themes) || data.themes.length === 0) fail('缺少 root 或 themes');
  const ids = new Set();
  for (const t of [data.root, ...data.themes]) {
    if (!t.id || typeof t.id !== 'string') fail('主题缺少 id');
    if (ids.has(t.id)) fail(`重复的主题 id：${t.id}`);
    ids.add(t.id);
    if (!t.palette || typeof t.palette !== 'object') fail(`${t.id} 缺少 palette`);
    if (!t.semantic || typeof t.semantic !== 'object') fail(`${t.id} 缺少 semantic`);
    if (!t.state || typeof t.state !== 'object') fail(`${t.id} 缺少 state`);
    for (const key of Object.keys(t.palette)) {
      if (!/^(neutral|primary|accent)-\d+$/.test(key)) fail(`${t.id} 的调色板键不合规：${key}`);
      if (typeof t.palette[key] !== 'string' || !t.palette[key].trim()) fail(`${t.id}.${key} 不是颜色字符串`);
    }
    for (const key of SEMANTIC_ORDER) {
      const ref = t.semantic[key];
      if (!ref) fail(`${t.id} 缺少语义键 ${key}`);
      // 值是调色板 key 或直接颜色；是 key 就必须真存在于本主题，
      // 否则浏览器会拿到空值（var() 引用未定义变量 = 该声明失效）。
      if (/^(neutral|primary|accent)-\d+$/.test(ref) && !(ref in t.palette)) {
        fail(`${t.id}.${key} 引用了不存在的调色板键 ${ref}`);
      }
    }
    for (const key of STATE_ORDER) {
      const v = t.state[key];
      if (typeof v !== 'string' || !v.trim()) fail(`${t.id} 缺少状态色 ${key}`);
    }
  }

  // groups 是可选的（老数据没有），一旦写了就必须自洽。
  if (data.groups !== undefined) validateGroups(data.groups, ids);
}

function validateGroups(groups, ids) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) fail('groups 必须是对象');
  const seen = new Set();
  for (const key of GROUP_KEYS) {
    const list = groups[key];
    if (!Array.isArray(list)) fail(`groups.${key} 必须是数组`);
    for (const id of list) {
      if (typeof id !== 'string' || !ids.has(id)) fail(`groups.${key} 里有不存在的主题 id：${id}`);
      if (seen.has(id)) fail(`主题 ${id} 在 groups 里出现了不止一次（三组应是分区，不重叠）`);
      seen.add(id);
    }
  }
  for (const extra of Object.keys(groups)) {
    if (!GROUP_KEYS.includes(extra)) fail(`groups 里有未知分组：${extra}`);
  }
  // 只比 themes[] 的 id：root 是首屏兜底色，不是可选主题，不该出现在选择器里。
  for (const id of ids) {
    if (id === 'root') continue;
    if (!seen.has(id)) fail(`主题 ${id} 没有归入任何分组（前端会漏掉它）`);
  }
}

const isPaletteRef = (value) => /^(neutral|primary|accent)-\d+$/.test(value);

function paletteLines(theme, indent) {
  const out = [];
  for (const [prefix, title] of PALETTE_GROUPS) {
    const keys = Object.keys(theme.palette).filter((k) => k.startsWith(`${prefix}-`));
    if (keys.length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(`${indent}/* ${title} */`);
    for (const key of keys) out.push(`${indent}--${key}: ${theme.palette[key]};`);
  }
  return out;
}

function semanticLines(theme, indent) {
  const out = [`${indent}/* 语义 */`];
  for (const key of SEMANTIC_ORDER) {
    const value = theme.semantic[key];
    out.push(`${indent}--hyacinth-${key}: ${isPaletteRef(value) ? `var(--${value})` : value};`);
  }
  return out;
}

function stateLines(theme, indent) {
  return STATE_ORDER.map((key) => `${indent}--state-${key}: ${theme.state[key]};`);
}

function rootBlock(theme) {
  const indent = '  ';
  const lines = ['/* 默认（没有 data-theme 时的首屏底色）：themes.json 的 root */', ':root {'];
  lines.push(...paletteLines(theme, indent));
  lines.push('', ...semanticLines(theme, indent));
  lines.push('', `${indent}/* 状态 */`, ...stateLines(theme, indent));
  lines.push('', `${indent}/* Legacy fallback aliases */`);
  for (const key of LEGACY_ALIASES) lines.push(`${indent}--${key}: var(--hyacinth-${key});`);
  lines.push('}');
  return lines.join('\n');
}

function themeBlock(theme) {
  const indent = '  ';
  const lines = [`/* ${theme.label || theme.id}（${theme.id}） */`, `html[data-theme='${theme.id}'] {`];
  lines.push(...paletteLines(theme, indent));
  lines.push('', ...semanticLines(theme, indent));
  lines.push('', `${indent}/* 状态 */`, ...stateLines(theme, indent));
  lines.push('}');
  return lines.join('\n');
}

function render(data) {
  const chunks = [BEGIN, rootBlock(data.root)];
  for (const theme of data.themes) chunks.push(themeBlock(theme));
  chunks.push(END);
  return chunks.join('\n');
}

function main() {
  const data = readJson();
  validate(data);

  let css;
  try {
    css = fs.readFileSync(CSS_FILE, 'utf8');
  } catch (error) {
    fail(`读不到 ${path.relative(ROOT, CSS_FILE)}：${error.message}`);
  }

  const begin = css.indexOf(BEGIN);
  const end = css.indexOf(END);
  if (begin < 0 || end < 0) fail('theme.css 里找不到 GENERATED 标记，拒绝整份重写（会把手写设计语言冲掉）');
  if (end < begin) fail('GENERATED 标记顺序反了');
  if (css.indexOf(BEGIN, begin + BEGIN.length) >= 0) fail('GENERATED:BEGIN 出现了不止一次');

  const next = css.slice(0, begin) + render(data) + css.slice(end + END.length);

  if (process.argv.includes('--check')) {
    if (next !== css) {
      fail('theme.css 与 themes.json 不同步：跑一次 node scripts/gen-theme-css.cjs');
    }
    console.log('[gen-theme-css] 已同步');
    return;
  }

  if (next === css) {
    console.log('[gen-theme-css] 无变化');
    return;
  }
  fs.writeFileSync(CSS_FILE, next, 'utf8');
  console.log(`[gen-theme-css] 已写入 ${path.relative(ROOT, CSS_FILE)}（${data.themes.length + 1} 个颜色块）`);
}

main();
