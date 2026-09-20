// tools-dev/gen-themes.mjs —— 主题生成器 v2（按 ui-aesthetics 规范重做 ＋ **对比度当门禁** ✓）
//
// v1 → v2（依据：规范 `color-system.md` ＋ `style-archetypes.md` ✓）
//   ① **每套只留一个强调色** ✗：v1 的 cyber 用霓虹洋红＋电子青**双主色对轰** ⇒ 违反"accent 要集中" ✗
//      ⇒ v2：电子青当唯一强调 ✓，洋红降级为**近乎中性**的深紫灰 ✓
//   ② **别拿暖白当高级感** ✗：v1 的 paper 偏奶偏黄 ✗ ⇒ v2 暖度收紧（只保留"纸"这一层材质依据 ✓）
//   ③ **发光要罕见** ✗：v1 的 cyber/terminal 到处 glow ✗ ⇒ v2 改用**亮度台阶 ＋ 边线**做层次 ✓
//   ④ **档位锚定**（v2 新增，修 v1 的设计缺陷 ✗）：v1 用 5 锚等距插值 ⇒ "次级文字"档（500）
//      落在**过浅**处 ⇒ 对比度必不达标 ✗ ⇒ v2 直接在 **0/300/500/600/900** 五档锚定 ✓
//   ⑤ **对比度门禁** ✓：生成前算 WCAG（正文 ≥4.5 · 次级 ≥4.5 · 强调面 ≥3.0）⇒ 不达标**拒绝写盘** ✗
//      —— 判据是**数字**，不是"看着还行" ✓
//
// 幂等：v1 是"只追加 ＋ 撞名退出" ✗（重跑不了 ✗）⇒ v2 用**标记区**替换 ✓
//   · 有 `/* @@themes:start @@ */` ⇒ 从它截断 ✓
//   · 老文件没有标记 ⇒ 从**第一处 v1 生成块**（`/* ── mono（`）截断 ✓（`light/dark/glass/ink/rainy` 全保留 ✓）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth';
const CSS = path.join(ROOT, 'src', 'webui', 'theme.css');
const APP = path.join(ROOT, 'src', 'webui', 'app.js');

// ── 颜色工具（含 WCAG 对比度 ✓）──
const hex2rgb = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const rgb2hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => rgb2hex(hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * t));
const lum = (h) => {
  const [r, g, b] = hex2rgb(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const STOPS = [0, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900];
/** 锚定在**关键档位**上（形如 [[0,'#fff'],[500,'#6b7280'],[900,'#111827']] ✓） */
function scale(anchors) {
  const a = anchors.slice().sort((x, y) => x[0] - y[0]);
  const out = {};
  for (const s of STOPS) {
    if (s <= a[0][0]) { out[s] = a[0][1]; continue; }
    if (s >= a[a.length - 1][0]) { out[s] = a[a.length - 1][1]; continue; }
    let i = 0;
    while (i < a.length - 1 && !(s >= a[i][0] && s <= a[i + 1][0])) i++;
    const [lo, hi] = [a[i], a[i + 1]];
    out[s] = mix(lo[1], hi[1], (s - lo[0]) / (hi[0] - lo[0]));
  }
  return out;
}
const emit = (p, sc) => STOPS.map((s) => `  --${p}-${s}: ${sc[s]};`).join('\n');

// ── 6 套（每套一个原型 ＋ **唯一强调色** ✓；500 档刻意定在"次级文字可用"的深度 ✓）──
const THEMES = [
  { id: 'mono', name: '极简', desc: '素白 · 冷灰 · 一处克制强调', archetype: 'Quiet Product Precision',
    neutral: [[0, '#ffffff'], [300, '#dde1e7'], [500, '#6b7280'], [600, '#4b5563'], [900, '#0f172a']],
    primary: [[0, '#f8fafc'], [300, '#94a3b8'], [500, '#475569'], [600, '#334155'], [900, '#0b1220']],
    accent: [[0, '#f1f5f9'], [300, '#cbd5e1'], [500, '#64748b'], [600, '#475569'], [900, '#1e293b']],
    design: ['  --radius-sm: 3px;', '  --radius-md: 6px;', '  --radius-lg: 8px;', '  --radius-xl: 10px;', '  --radius-2xl: 12px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 1px 2px rgba(15, 23, 42, 0.06);', '  --shadow-lg: 0 2px 10px rgba(15, 23, 42, 0.08);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(255, 255, 255, 0.5);'] },
  { id: 'cyber', name: '赛博朋克', desc: '近黑 · 电子青为唯一强调 · 硬直角', archetype: 'Restrained Futuristic Interface',
    neutral: [[0, '#07080c'], [300, '#151922'], [500, '#868fa4'], [600, '#98a3b5'], [900, '#e8ecf4']],
    primary: [[0, '#062a33'], [300, '#0d6a7d'], [500, '#22c1d6'], [600, '#67e8f9'], [900, '#eafdff']],
    accent: [[0, '#14111c'], [300, '#3a3350'], [500, '#6d6488'], [600, '#8d84a8'], [900, '#ded9ee']],
    design: ['  --radius-sm: 0px;', '  --radius-md: 0px;', '  --radius-lg: 2px;', '  --radius-xl: 2px;', '  --radius-2xl: 4px;',
      '  --shadow-sm: 0 0 0 0 transparent;',
      '  --shadow-md: 0 1px 0 rgba(34, 193, 214, 0.12);',
      '  --shadow-lg: 0 0 16px rgba(34, 193, 214, 0.20);',
      '  --font-sans: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(7, 8, 12, 0.66);'] },
  { id: 'paper', name: '报纸', desc: '近白纸 · 墨黑 · 衬线 · 一处朱印', archetype: 'Soft Editorial Minimalism',
    neutral: [[0, '#fefdfb'], [300, '#e6e1d8'], [500, '#6f6a5e'], [600, '#514c42'], [900, '#17150f']],
    primary: [[0, '#f6f4ef'], [300, '#a49c8c'], [500, '#4a4438'], [600, '#332f26'], [900, '#12100b']],
    accent: [[0, '#fbf1ee'], [300, '#c9806f'], [500, '#9c4232'], [600, '#7a3125'], [900, '#3a1410']],
    design: ['  --radius-sm: 0px;', '  --radius-md: 2px;', '  --radius-lg: 2px;', '  --radius-xl: 3px;', '  --radius-2xl: 4px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 1px 1px rgba(23, 21, 15, 0.10);', '  --shadow-lg: 0 2px 6px rgba(23, 21, 15, 0.12);',
      '  --font-display: "Noto Serif SC", "Songti SC", "SimSun", Georgia, serif;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(254, 253, 251, 0.55);'] },
  { id: 'terminal', name: '终端', desc: '纯黑 · 单色荧光 · 零圆角', archetype: 'Crisp Enterprise Console（单色变体）',
    neutral: [[0, '#000000'], [300, '#10170f'], [500, '#7f8c7f'], [600, '#a3b0a3'], [900, '#e4ece4']],
    primary: [[0, '#06170c'], [300, '#127a3c'], [500, '#35d06a'], [600, '#7ef0a4'], [900, '#e8fff0']],
    accent: [[0, '#141005'], [300, '#6b5a22'], [500, '#a08a3c'], [600, '#c4ad5c'], [900, '#efe6c4']],
    design: ['  --radius-sm: 0px;', '  --radius-md: 0px;', '  --radius-lg: 0px;', '  --radius-xl: 0px;', '  --radius-2xl: 0px;', '  --radius-full: 0px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 0 0 1px rgba(53, 208, 106, 0.16);', '  --shadow-lg: 0 0 12px rgba(53, 208, 106, 0.18);',
      '  --font-sans: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --font-display: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(0, 0, 0, 0.74);'] },
  { id: 'sunset', name: '日落', desc: '深紫暮色 · 一处琥珀 · 大圆角', archetype: 'Dark Luminous Control（暖色变体）',
    neutral: [[0, '#150e17'], [300, '#2a1f2e'], [500, '#94839a'], [600, '#a898ad'], [900, '#f2ebf2']],
    primary: [[0, '#241305'], [300, '#8a5411'], [500, '#d98a2b'], [600, '#f0ab5e'], [900, '#fdf3e6']],
    accent: [[0, '#241019'], [300, '#5c2a3e'], [500, '#9a5b74'], [600, '#b87e93'], [900, '#f0dde6']],
    design: ['  --radius-sm: 8px;', '  --radius-md: 14px;', '  --radius-lg: 20px;', '  --radius-xl: 24px;', '  --radius-2xl: 28px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 4px 16px rgba(21, 14, 23, 0.40);', '  --shadow-lg: 0 10px 32px rgba(21, 14, 23, 0.46);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: radial-gradient(680px 420px at 80% 10%, rgba(217, 138, 43, 0.13), transparent 64%);',
      '  --hyacinth-user-bg-scrim: rgba(21, 14, 23, 0.55);'] },
  { id: 'glacier', name: '冰川', desc: '冷白 · 钢蓝 · 中圆角', archetype: 'Quiet Product Precision（冷亮版）',
    neutral: [[0, '#ffffff'], [300, '#dbe7f2'], [500, '#55698a'], [600, '#445a75'], [900, '#0f1e33']],
    primary: [[0, '#eff6ff'], [300, '#7fa9dd'], [500, '#2f6bbf'], [600, '#1f4f96'], [900, '#0d2447']],
    accent: [[0, '#f1fbfc'], [300, '#8fc4cd'], [500, '#3f8f9c'], [600, '#2c6b76'], [900, '#0d2b32']],
    design: ['  --radius-sm: 6px;', '  --radius-md: 12px;', '  --radius-lg: 16px;', '  --radius-xl: 20px;', '  --radius-2xl: 24px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 3px 14px rgba(15, 30, 51, 0.09);', '  --shadow-lg: 0 10px 30px rgba(15, 30, 51, 0.12);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(255, 255, 255, 0.5);'] },
];

// ── ① 门禁：算对比度（不达标 ⇒ 拒绝写盘 ✗）──
console.log('  对比度门禁（正文 ≥4.5 ✓ · 次级 ≥4.5 ✓ · 强调面 ≥3.0 ✓）');
const fails = [];
for (const t of THEMES) {
  const n = scale(t.neutral); const p = scale(t.primary);
  const c1 = contrast(n[900], n[50]);    // 正文 vs 背景
  const c2 = contrast(n[500], n[50]);    // 次级文字 vs 背景
  const c3 = contrast(p[500], n[50]);    // 强调 vs 背景
  const o1 = c1 >= 4.5, o2 = c2 >= 4.5, o3 = c3 >= 3.0;
  if (!o1) fails.push(t.id + ' 正文 ' + c1.toFixed(2));
  if (!o2) fails.push(t.id + ' 次级 ' + c2.toFixed(2));
  if (!o3) fails.push(t.id + ' 强调 ' + c3.toFixed(2));
  console.log('   · ' + t.id.padEnd(9) + ' 正文 ' + c1.toFixed(2) + (o1 ? ' ✓' : ' ✗') +
    '   次级 ' + c2.toFixed(2) + (o2 ? ' ✓' : ' ✗') + '   强调 ' + c3.toFixed(2) + (o3 ? ' ✓' : ' ✗') + '   [' + t.archetype + ']');
}
if (fails.length) { console.error('✗ 不达标 ⇒ 拒绝写盘 ✗：' + fails.join(' / ')); process.exit(1); }
console.log('   ✓ 6 套全达标（数字为准 ✓）');

// ── ② 写 theme.css（标记区替换 ⇒ 幂等 ✓）──
const css = fs.readFileSync(CSS, 'utf8');
const START = '/* @@themes:start @@ */';
const END = '/* @@themes:end @@ */';
const cutAt = css.includes(START) ? css.indexOf(START) : css.indexOf('/* ── mono（');
if (cutAt < 0) { console.error('✗ 既无标记也无 v1 生成块 ⇒ 找不到截断点 ⇒ 中止，未写盘'); process.exit(1); }
const head = css.slice(0, cutAt).replace(/\s*$/, '\n');
const body = THEMES.map((t) => {
  const n = scale(t.neutral), p = scale(t.primary), a = scale(t.accent);
  return ['', `/* ── ${t.id}（${t.name} · ${t.desc}）· 原型：${t.archetype} ── */`, `html[data-theme='${t.id}'] {`,
    '  /* 调色板（关键档锚定 ✓：0 / 300 / 500 / 600 / 900）*/', emit('neutral', n), '', emit('primary', p), '', emit('accent', a), '',
    '  /* 设计语言层：气质靠这几项 ＋ 亮度台阶 ✓（发光克制 ✗）*/', ...t.design, '}'].join('\n');
}).join('\n');
fs.writeFileSync(CSS, head + '\n' + START + '\n' + body + '\n' + END + '\n', 'utf8');
console.log('  ✓ theme.css：6 套已重写（标记区内 ✓，可幂等重跑 ✓）');

// ── ③ app.js 色卡（同 6 个 id，仅刷新色块 ✓）──
const sw = (t) => { const n = scale(t.neutral), p = scale(t.primary), a = scale(t.accent); return [n[50], n[150], p[500], a[500], n[900]]; };
const list = [
  { id: 'hyacinth', name: '夜园', desc: '夜花园 · 萤光花穗', swatches: ['#0f1120', '#161930', '#a78bfa', '#2dd4bf', '#eceefa'] },
  { id: 'light', name: '昼园', desc: '水彩花园 · 清晨', swatches: ['#f6f8f3', '#fdfefc', '#c9baf6', '#43a461', '#1a2016'] },
  ...THEMES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, swatches: sw(t) })),
];
let app = fs.readFileSync(APP, 'utf8');
const m = app.match(/  const THEMES = \[[\s\S]*?\n  \];/);
if (!m) { console.error('✗ app.js 里没找到 THEMES 数组 ⇒ 中止'); process.exit(1); }
app = app.replace(m[0], '  const THEMES = [\n' + list.map((t) =>
  `    { id: '${t.id}', name: '${t.name}', desc: '${t.desc}',\n      swatches: [${t.swatches.map((s) => `'${s}'`).join(', ')}] },`).join('\n') + '\n  ];');
fs.writeFileSync(APP, app, 'utf8');
console.log('  ✓ app.js：色卡刷新（可见主题仍 ' + list.length + ' 个 ✓）');

// ── ④ 写后自检 ──
const back = fs.readFileSync(CSS, 'utf8').split('\r\n').join('\n');
const appBack = fs.readFileSync(APP, 'utf8').split('\r\n').join('\n');
const count = (s, re) => (s.match(re) || []).length;
const checks = [
  ['标记区在 ✓', back.includes(START) && back.includes(END)],
  ['6 套 id 各出现 1 次 ✓', THEMES.every((t) => count(back, new RegExp(`html\\[data-theme='${t.id}'\\] \\{`, 'g')) === 1)],
  ['旧 5 套仍在（light/dark/glass/ink/rainy ✓）', ['light', 'dark', 'glass', 'ink', 'rainy'].every((x) => back.includes(`html[data-theme='${x}'] {`))],
  ['cyber 不再双主色（洋红已降级 ✓）', !back.includes('--accent-500: #ec4899;')],
  // ⚠️ 上一版这里写死 `--neutral-50` 的"期望值"⇒ **插值后根本不是那个数** ⇒ 假红 ✗
  //    （同族坑 ⑪：负向/正向断言都不该拿**凭印象的文本**当锚 ✗）
  //    ⇒ 改为：断"锚值"（0 档是原样写入的 ✓ 必然精确 ✓）＋ 断"旧奶黄确实消失"（真存在过的值 ✓）
  ['paper 暖度收紧（0 档＝近白纸 ✓ 且旧奶黄已消失 ✓）', back.includes('--neutral-0: #fefdfb;') && !back.includes('#f3ecdd')],
  ['app.js 色卡已更新 ✓', appBack.includes("id: 'cyber', name: '赛博朋克'")],
];
let bad = 0;
for (const [what, ok] of checks) { if (!ok) { console.error('✗ 自检未过：' + what); bad++; } }
console.log(bad ? '✗ 自检失败（已写盘，需人工修 ✗）' : '✓ 写后自检通过（' + checks.length + ' 项）');
process.exit(bad ? 1 : 0);
