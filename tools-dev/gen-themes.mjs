// tools-dev/gen-themes.mjs —— 主题生成器 v3（用户：第一个全紫太丑 ＋ 都重做 ✓）
//
// v2 → v3 变了什么（依据：用户反馈 ＋ 规范 `color-system.md` ✓）
//   ① **夜园（默认）重做** ✗：用户「第一个全紫色太丑了」✓ —— 病根是**紫色糊满整屏** ✗
//      ⇒ v3：底色改**近黑冷灰**（紫从"背景"里拿掉 ✓），紫色**只保留在 primary 的中间几档**
//        ⇒ 只出现在"主操作 / 当前选中 / 一处品牌字"上 ✓（规范："accent 集中在 CTA、活动态、一处英雄信号" ✓）
//      ⚠️ 注意：夜园 ＝ `:root` 的默认调色板 ⇒ v3 改为**显式输出 `html[data-theme='hyacinth']` 块** ✓
//        （元素选择器 ＋ 属性选择器 ⇒ 优先级高于 `:root` ⇒ 覆盖生效 ✓ 且**不动基础文件结构** ✓）
//   ② **昼园重做** ✗：原版"水彩绿紫"太虚 ⇒ v3：冷白打底 ＋ **一点苔绿**（Quiet Product Precision ✓）
//   ③ **日落 → 青瓷（新）** ✓：规范把"暖色 ＋ 渐变当高级感"列为 anti-pattern ✗
//      ⇒ 换成"青瓷釉面"：哑光、低对比但**仍过 AA**、器物感 ✓（新 id `celadon` ⇒ schema 白名单要同步 ✓）
//   ④ 极简 / 赛博朋克 / 报纸 / 终端 / 冰川：沿用 v2（已合规范 ✓），只做色相微调 ✓
//
// 沿用 v2 的三条纪律 ✓：**档位锚定**（0/300/500/600/900 ✓）· **对比度门禁**（不达标拒绝写盘 ✗）· **标记区替换 ⇒ 幂等** ✓
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth';
const CSS = path.join(ROOT, 'src', 'webui', 'theme.css');
const APP = path.join(ROOT, 'src', 'webui', 'app.js');
const SCHEMA = path.join(ROOT, 'src', 'runtime', 'config-schema.ts');

const hex2rgb = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const rgb2hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => rgb2hex(hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * t));
const lum = (h) => {
  const [r, g, b] = hex2rgb(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const STOPS = [0, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900];
function scale(anchors) {
  const a = anchors.slice().sort((x, y) => x[0] - y[0]);
  const out = {};
  for (const s of STOPS) {
    if (s <= a[0][0]) { out[s] = a[0][1]; continue; }
    if (s >= a[a.length - 1][0]) { out[s] = a[a.length - 1][1]; continue; }
    let i = 0;
    while (i < a.length - 1 && !(s >= a[i][0] && s <= a[i + 1][0])) i++;
    out[s] = mix(a[i][1], a[i + 1][1], (s - a[i][0]) / (a[i + 1][0] - a[i][0]));
  }
  return out;
}
const emit = (p, sc) => STOPS.map((s) => `  --${p}-${s}: ${sc[s]};`).join('\n');

// ── 8 套（含重做的夜园/昼园 ＋ 新的青瓷 ✓）──
const THEMES = [
  { id: 'hyacinth', name: '夜园', desc: '夜色 · 紫只做一处信号', archetype: 'Dark Luminous Control',
    neutral: [[0, '#08090e'], [300, '#161a24'], [500, '#7d8899'], [600, '#95a0b0'], [900, '#e9edf5']],   // 近黑冷灰 ⇒ 紫从背景里拿掉 ✓
    primary: [[0, '#16122a'], [300, '#4c3f8f'], [500, '#8b7ae0'], [600, '#a99cf0'], [900, '#efecff']],   // 紫只在中间几档 ⇒ 只服务于"主操作/当前" ✓
    accent: [[0, '#07211f'], [300, '#136b63'], [500, '#2fb3a4'], [600, '#6fd6c9'], [900, '#e6fffb']],    // 露青只作极小点缀 ✓
    design: ['  --radius-sm: 6px;', '  --radius-md: 10px;', '  --radius-lg: 14px;', '  --radius-xl: 16px;', '  --radius-2xl: 20px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 4px 18px rgba(5, 6, 12, 0.45);', '  --shadow-lg: 0 12px 40px rgba(5, 6, 12, 0.52);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: radial-gradient(520px 340px at 84% 6%, rgba(139, 122, 224, 0.10), transparent 62%);',
      '  --hyacinth-user-bg-scrim: rgba(8, 9, 14, 0.6);'] },
  { id: 'light', name: '昼园', desc: '晨光纸面 · 冷白 ＋ 一点苔绿', archetype: 'Quiet Product Precision',
    neutral: [[0, '#ffffff'], [300, '#e4e9ef'], [500, '#5d6b7a'], [600, '#45525f'], [900, '#101a24']],
    primary: [[0, '#f0faf7'], [300, '#4fae9c'], [500, '#1f8471'], [600, '#15695a'], [900, '#062b24']],
    accent: [[0, '#f3f6f9'], [300, '#c3ccd6'], [500, '#6b7a89'], [600, '#526171'], [900, '#1d2b38']],
    design: ['  --radius-sm: 5px;', '  --radius-md: 10px;', '  --radius-lg: 14px;', '  --radius-xl: 16px;', '  --radius-2xl: 20px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 2px 10px rgba(16, 26, 36, 0.08);', '  --shadow-lg: 0 8px 26px rgba(16, 26, 36, 0.10);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(255, 255, 255, 0.5);'] },
  { id: 'mono', name: '极简', desc: '素白 · 冷灰 · 纯结构', archetype: 'Quiet Product Precision',
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
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 1px 0 rgba(34, 193, 214, 0.12);', '  --shadow-lg: 0 0 16px rgba(34, 193, 214, 0.20);',
      '  --font-sans: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(7, 8, 12, 0.66);'] },
  { id: 'paper', name: '报纸', desc: '近白纸 · 墨黑 · 衬线 · 一枚朱印', archetype: 'Soft Editorial Minimalism',
    neutral: [[0, '#fefdfb'], [300, '#e6e1d8'], [500, '#6f6a5e'], [600, '#514c42'], [900, '#17150f']],
    primary: [[0, '#f6f4ef'], [300, '#a49c8c'], [500, '#4a4438'], [600, '#332f26'], [900, '#12100b']],
    accent: [[0, '#fbf1ee'], [300, '#c9806f'], [500, '#9c4232'], [600, '#7a3125'], [900, '#3a1410']],
    design: ['  --radius-sm: 0px;', '  --radius-md: 2px;', '  --radius-lg: 2px;', '  --radius-xl: 3px;', '  --radius-2xl: 4px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 1px 1px rgba(23, 21, 15, 0.10);', '  --shadow-lg: 0 2px 6px rgba(23, 21, 15, 0.12);',
      '  --font-display: "Noto Serif SC", "Songti SC", "SimSun", Georgia, serif;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(254, 253, 251, 0.55);'] },
  { id: 'terminal', name: '终端', desc: '纯黑 · 单色荧光 · 零圆角', archetype: 'Crisp Enterprise Console（单色）',
    neutral: [[0, '#000000'], [300, '#10170f'], [500, '#7f8c7f'], [600, '#a3b0a3'], [900, '#e4ece4']],
    primary: [[0, '#06170c'], [300, '#127a3c'], [500, '#35d06a'], [600, '#7ef0a4'], [900, '#e8fff0']],
    accent: [[0, '#141005'], [300, '#6b5a22'], [500, '#a08a3c'], [600, '#c4ad5c'], [900, '#efe6c4']],
    design: ['  --radius-sm: 0px;', '  --radius-md: 0px;', '  --radius-lg: 0px;', '  --radius-xl: 0px;', '  --radius-2xl: 0px;', '  --radius-full: 0px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 0 0 1px rgba(53, 208, 106, 0.16);', '  --shadow-lg: 0 0 12px rgba(53, 208, 106, 0.18);',
      '  --font-sans: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --font-display: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(0, 0, 0, 0.74);'] },
  { id: 'glacier', name: '冰川', desc: '冷白 · 钢蓝 · 中圆角', archetype: 'Quiet Product Precision（冷亮版）',
    neutral: [[0, '#ffffff'], [300, '#dbe7f2'], [500, '#55698a'], [600, '#445a75'], [900, '#0f1e33']],
    primary: [[0, '#eff6ff'], [300, '#7fa9dd'], [500, '#2f6bbf'], [600, '#1f4f96'], [900, '#0d2447']],
    accent: [[0, '#f1fbfc'], [300, '#8fc4cd'], [500, '#3f8f9c'], [600, '#2c6b76'], [900, '#0d2b32']],
    design: ['  --radius-sm: 6px;', '  --radius-md: 12px;', '  --radius-lg: 16px;', '  --radius-xl: 20px;', '  --radius-2xl: 24px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 3px 14px rgba(15, 30, 51, 0.09);', '  --shadow-lg: 0 10px 30px rgba(15, 30, 51, 0.12);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(255, 255, 255, 0.5);'] },
  { id: 'celadon', name: '青瓷', desc: '青瓷釉面 · 温润哑光 · 器物感', archetype: 'Soft Editorial Minimalism（器物变体）',
    neutral: [[0, '#fbfdfb'], [300, '#dfe7e2'], [500, '#5f736a'], [600, '#475a52'], [900, '#16211d']],
    primary: [[0, '#f1f8f4'], [300, '#8fbfa8'], [500, '#3f8f6f'], [600, '#2c7057'], [900, '#0c2b20']],
    accent: [[0, '#faf6f2'], [300, '#cdb9a8'], [500, '#8a7159'], [600, '#6b5743'], [900, '#2a2018']],
    design: ['  --radius-sm: 8px;', '  --radius-md: 14px;', '  --radius-lg: 18px;', '  --radius-xl: 22px;', '  --radius-2xl: 26px;',
      '  --shadow-sm: 0 0 0 0 transparent;', '  --shadow-md: 0 2px 12px rgba(22, 33, 29, 0.08);', '  --shadow-lg: 0 8px 28px rgba(22, 33, 29, 0.10);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;', '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(255, 255, 255, 0.5);'] },
];

// ── ① 对比度门禁 ✓ ──
console.log('  对比度门禁（正文 ≥4.5 · 次级 ≥4.5 · 强调 ≥3.0 ✓）');
const fails = [];
for (const t of THEMES) {
  const n = scale(t.neutral), p = scale(t.primary);
  const c1 = contrast(n[900], n[50]), c2 = contrast(n[500], n[50]), c3 = contrast(p[500], n[50]);
  const o1 = c1 >= 4.5, o2 = c2 >= 4.5, o3 = c3 >= 3.0;
  if (!o1) fails.push(t.id + ' 正文 ' + c1.toFixed(2));
  if (!o2) fails.push(t.id + ' 次级 ' + c2.toFixed(2));
  if (!o3) fails.push(t.id + ' 强调 ' + c3.toFixed(2));
  console.log('   · ' + t.id.padEnd(9) + ' 正文 ' + c1.toFixed(2) + (o1 ? ' ✓' : ' ✗') +
    '   次级 ' + c2.toFixed(2) + (o2 ? ' ✓' : ' ✗') + '   强调 ' + c3.toFixed(2) + (o3 ? ' ✓' : ' ✗') + '   [' + t.archetype + ']');
}
if (fails.length) { console.error('✗ 不达标 ⇒ 拒绝写盘 ✗：' + fails.join(' / ')); process.exit(1); }
console.log('   ✓ 8 套全达标（数字为准 ✓）');

// ── ② theme.css：标记区替换 ✓（含夜园/昼园的显式块 ✓）──
const css = fs.readFileSync(CSS, 'utf8');
const START = '/* @@themes:start @@ */';
const END = '/* @@themes:end @@ */';
const cutAt = css.includes(START) ? css.indexOf(START) : css.indexOf('/* ── mono（');
if (cutAt < 0) { console.error('✗ 找不到截断点 ⇒ 中止，未写盘'); process.exit(1); }
let head = css.slice(0, cutAt).replace(/\s*$/, '\n');

// ⚠️ 同 id 去重（v3.1 补 ✓）：旧区里若已有同名块 ⇒ 整段删掉 ✗
//   否则 `light` 会有两份（旧区 1 ＋ 标记区 1）⇒ 功能上后者胜出（看着没事 ✗），
//   但留下死代码 ✗ 且自检「各 1 次」必红 ✓（v3 首跑就是这么红的 ✓）
//   刻意用**纯字符串定位** ✗：正则转义在「补丁脚本里再写正则」这种两层嵌套下极易写错 ✓
const BLOCK_HEAD = "html[data-theme='";
for (const t of THEMES) {
  const key = BLOCK_HEAD + t.id + "'] {";
  let i = head.indexOf(key);
  while (i >= 0) {
    const end = head.indexOf('\n}\n', i);
    if (end < 0) break;
    head = head.slice(0, i) + head.slice(end + 3);
    i = head.indexOf(key);
  }
}
const body = THEMES.map((t) => {
  const n = scale(t.neutral), p = scale(t.primary), a = scale(t.accent);
  return ['', `/* ── ${t.id}（${t.name} · ${t.desc}）· 原型：${t.archetype} ── */`, `html[data-theme='${t.id}'] {`,
    '  /* 调色板（关键档锚定 ✓：0 / 300 / 500 / 600 / 900）*/', emit('neutral', n), '', emit('primary', p), '', emit('accent', a), '',
    '  /* 设计语言层：气质靠这几项 ＋ 亮度台阶 ✓（发光克制 ✗）*/', ...t.design, '}'].join('\n');
}).join('\n');
fs.writeFileSync(CSS, head + '\n' + START + '\n' + body + '\n' + END + '\n', 'utf8');
console.log('  ✓ theme.css：8 套已重写（含夜园/昼园显式块 ⇒ 覆盖 `:root` 默认 ✓）');

// ── ③ app.js 色卡（8 个 ✓）──
const sw = (t) => { const n = scale(t.neutral), p = scale(t.primary), a = scale(t.accent); return [n[50], n[150], p[500], a[500], n[900]]; };
const list = THEMES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, swatches: sw(t) }));
let app = fs.readFileSync(APP, 'utf8');
const m = app.match(/  const THEMES = \[[\s\S]*?\n  \];/);
if (!m) { console.error('✗ app.js 没有 THEMES 数组 ⇒ 中止'); process.exit(1); }
app = app.replace(m[0], '  const THEMES = [\n' + list.map((t) =>
  `    { id: '${t.id}', name: '${t.name}', desc: '${t.desc}',\n      swatches: [${t.swatches.map((s) => `'${s}'`).join(', ')}] },`).join('\n') + '\n  ];');
fs.writeFileSync(APP, app, 'utf8');
console.log('  ✓ app.js：色卡刷新（' + list.length + ' 个可见主题 ✓）');

// ── ④ schema 白名单（加 celadon ✓，旧 id 全保留 ⇒ 用户存过的主题不会失效 ✓）──
const ALL = ['hyacinth', 'light', 'dark', 'glass', 'ink', 'rainy', 'sunset', 'mono', 'cyber', 'paper', 'terminal', 'glacier', 'celadon'];
let sc = fs.readFileSync(SCHEMA, 'utf8');
const scRe = /theme: [^\n]*;/;
if (!scRe.test(sc)) { console.error('✗ schema 里没找到 theme 白名单 ⇒ 中止'); process.exit(1); }
sc = sc.replace(scRe, `theme: ${ALL.map((id) => `'${id}'`).join(' | ')};`);
fs.writeFileSync(SCHEMA, sc, 'utf8');
console.log('  ✓ config-schema.ts：白名单 ' + ALL.length + ' 个（含新 celadon ✓）');

// ── ⑤ 写后自检 ──
const back = fs.readFileSync(CSS, 'utf8').split('\r\n').join('\n');
const appBack = fs.readFileSync(APP, 'utf8').split('\r\n').join('\n');
const scBack = fs.readFileSync(SCHEMA, 'utf8');
const count = (s, re) => (s.match(re) || []).length;
const checks = [
  ['标记区在 ✓', back.includes(START) && back.includes(END)],
  ['8 套各 1 次 ✓', THEMES.every((t) => count(back, new RegExp(`html\\[data-theme='${t.id}'\\] \\{`, 'g')) === 1)],
  ['夜园不再"全紫"（背景是近黑冷灰 ✓）', back.includes('--neutral-50: #0a0c12;') || back.includes("html[data-theme='hyacinth'] {")],
  ['旧 5 套仍在 ✓', ['light', 'dark', 'glass', 'ink', 'rainy'].every((x) => count(back, new RegExp(`html\\[data-theme='${x}'\\] \\{`, 'g')) === 1)],
  ['青瓷已生成 ✓', back.includes("html[data-theme='celadon'] {")],
  ['app.js 色卡 8 个 ✓', appBack.includes("id: 'celadon', name: '青瓷'") && appBack.includes("id: 'hyacinth', name: '夜园'")],
  ['schema 含 celadon ✓', scBack.includes("'celadon'")],
];
let bad = 0;
for (const [what, ok] of checks) { if (!ok) { console.error('✗ 自检未过：' + what); bad++; } }
console.log(bad ? '✗ 自检失败（已写盘，需人工修 ✗）' : '✓ 写后自检通过（' + checks.length + ' 项）');
process.exit(bad ? 1 : 0);
