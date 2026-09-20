// tools-dev/_gen-themes.mjs —— 生成 6 套风格迥异的新主题（一次性生成器 ✓ 产物写进仓库 ✓）
//
// 机制（读 theme.css 得到 ✓，不是推测）：
//   · 三层令牌：调色板(--neutral/--primary/--accent) → 语义层(--hyacinth-*) → 设计语言层(radius/shadow/font/bg)
//   · 语义层在 :root 里是 `var()` 引用 ⇒ **只覆盖调色板即可**换风格 ✓
//   · 亮色主题 = 把 neutral 色阶**反向**（0=最亮 → 900=最暗 ✓ 见现存「昼园」）
//   · 设计语言层（圆角/阴影/字体/背景画）按主题单独覆盖 ⇒ 风格差异才真的"迥异" ✓
//
// 产物三处（都要改 ✓ 漏一处就白干 ✗）：
//   ① src/webui/theme.css      —— 追加主题块
//   ② src/webui/app.js         —— THEMES 清单（卡片名/描述/色卡 ✓）
//   ③ src/runtime/config-schema.ts —— theme 白名单（否则 config.set 会拒 ✗）
import fs from 'node:fs';

const ROOT = 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth';
const CSS = ROOT + '\\src\\webui\\theme.css';
const APP = ROOT + '\\src\\webui\\app.js';
const SCHEMA = ROOT + '\\src\\runtime\\config-schema.ts';

// ── 颜色小工具 ────────────────────────────────────────────────
const hex2rgb = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const rgb2hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => rgb2hex(hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * t));
/** 5 个锚点 → 13 档色阶（0,50,100,150,200,250,300,400,500,600,700,800,900 ✓） */
const STOPS = [0, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900];
function scale(anchors) {
  const out = {};
  STOPS.forEach((stop, i) => {
    const pos = (i / (STOPS.length - 1)) * (anchors.length - 1);
    const lo = Math.floor(pos); const hi = Math.min(anchors.length - 1, lo + 1);
    out[stop] = mix(anchors[lo], anchors[hi], pos - lo);
  });
  return out;
}
const emit = (prefix, sc) => STOPS.map((s) => `  --${prefix}-${s}: ${sc[s]};`).join('\n');

// ── 6 套新主题（风格刻意拉开 ✓）──────────────────────────────
const THEMES = [
  {
    id: 'mono', name: '极简', desc: '素白 · 灰度 · 无装饰',
    scheme: 'light',
    neutral: ['#ffffff', '#f4f4f5', '#d4d4d8', '#71717a', '#18181b'],
    primary: ['#f4f4f5', '#d4d4d8', '#52525b', '#27272a', '#0a0a0a'],
    accent: ['#fafafa', '#e4e4e7', '#a1a1aa', '#3f3f46', '#111111'],
    design: [
      '  --radius-sm: 2px;', '  --radius-md: 4px;', '  --radius-lg: 6px;',
      '  --radius-xl: 8px;', '  --radius-2xl: 10px;',
      '  --shadow-sm: 0 0 0 0 transparent;',
      '  --shadow-md: 0 1px 2px rgba(0, 0, 0, 0.06);',
      '  --shadow-lg: 0 2px 8px rgba(0, 0, 0, 0.08);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(255, 255, 255, 0.5);',
    ],
  },
  {
    id: 'cyber', name: '赛博朋克', desc: '霓虹洋红 · 电子青 · 硬直角',
    scheme: 'dark',
    neutral: ['#05040a', '#0b0a14', '#231f36', '#4a4468', '#eae6ff'],
    primary: ['#2a0a26', '#6b0f5f', '#c026d3', '#f0abfc', '#fdf4ff'],
    accent: ['#032f33', '#0e7490', '#22d3ee', '#a5f3fc', '#ecfeff'],
    design: [
      '  --radius-sm: 0px;', '  --radius-md: 0px;', '  --radius-lg: 2px;',
      '  --radius-xl: 2px;', '  --radius-2xl: 4px;',
      '  --shadow-sm: 0 0 0 0 transparent;',
      '  --shadow-md: 0 0 12px rgba(192, 38, 211, 0.35);',
      '  --shadow-lg: 0 0 28px rgba(192, 38, 211, 0.45);',
      '  --font-sans: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: radial-gradient(680px 420px at 85% 12%, rgba(192, 38, 211, 0.22), transparent 62%), radial-gradient(520px 380px at 12% 88%, rgba(34, 211, 238, 0.18), transparent 64%);',
      '  --hyacinth-user-bg-scrim: rgba(5, 4, 10, 0.62);',
    ],
  },
  {
    id: 'paper', name: '报纸', desc: '米黄纸 · 墨字 · 衬线',
    scheme: 'light',
    neutral: ['#fdfaf3', '#f3ecdd', '#ded2b8', '#8a7c60', '#241f17'],
    primary: ['#f0ece2', '#cfc6b4', '#6b6353', '#3a352b', '#1c1913'],
    accent: ['#fbeee9', '#e8bfb2', '#b4442c', '#7f2d1c', '#4a1a10'],
    design: [
      '  --radius-sm: 0px;', '  --radius-md: 2px;', '  --radius-lg: 2px;',
      '  --radius-xl: 3px;', '  --radius-2xl: 4px;',
      '  --shadow-sm: 0 0 0 0 transparent;',
      '  --shadow-md: 0 1px 1px rgba(36, 31, 23, 0.10);',
      '  --shadow-lg: 0 2px 6px rgba(36, 31, 23, 0.14);',
      '  --font-display: "Noto Serif SC", "Songti SC", "SimSun", Georgia, serif;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: none;',
      '  --hyacinth-user-bg-scrim: rgba(253, 250, 243, 0.55);',
    ],
  },
  {
    id: 'terminal', name: '终端', desc: '纯黑 · 荧光绿 · 等宽',
    scheme: 'dark',
    neutral: ['#000000', '#07120a', '#16331f', '#2f5c3d', '#d9ffe3'],
    primary: ['#04160a', '#0b3b1c', '#16a34a', '#4ade80', '#dcfce7'],
    accent: ['#1a1305', '#713f12', '#f59e0b', '#fde68a', '#fffbeb'],
    design: [
      '  --radius-sm: 0px;', '  --radius-md: 0px;', '  --radius-lg: 0px;',
      '  --radius-xl: 0px;', '  --radius-2xl: 0px;', '  --radius-full: 0px;',
      '  --shadow-sm: 0 0 0 0 transparent;',
      '  --shadow-md: 0 0 10px rgba(22, 163, 74, 0.28);',
      '  --shadow-lg: 0 0 22px rgba(22, 163, 74, 0.34);',
      '  --font-sans: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --font-display: "JetBrains Mono", "Cascadia Mono", "Consolas", monospace;',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: radial-gradient(700px 460px at 50% 0%, rgba(22, 163, 74, 0.16), transparent 68%);',
      '  --hyacinth-user-bg-scrim: rgba(0, 0, 0, 0.72);',
    ],
  },
  {
    id: 'sunset', name: '日落', desc: '暖橙 · 霞粉 · 大圆角',
    scheme: 'dark',
    neutral: ['#170b1a', '#221026', '#3a1f42', '#6b4a75', '#f7ecf5'],
    primary: ['#2a1206', '#7c2d12', '#f97316', '#fdba74', '#fff7ed'],
    accent: ['#2a0a1e', '#831843', '#ec4899', '#f9a8d4', '#fdf2f8'],
    design: [
      '  --radius-sm: 8px;', '  --radius-md: 14px;', '  --radius-lg: 20px;',
      '  --radius-xl: 24px;', '  --radius-2xl: 28px;',
      '  --shadow-sm: 0 0 0 0 transparent;',
      '  --shadow-md: 0 6px 22px rgba(43, 12, 20, 0.42);',
      '  --shadow-lg: 0 14px 44px rgba(43, 12, 20, 0.5);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: radial-gradient(720px 460px at 78% 8%, rgba(249, 115, 22, 0.20), transparent 64%), radial-gradient(560px 420px at 10% 92%, rgba(236, 72, 153, 0.18), transparent 66%);',
      '  --hyacinth-user-bg-scrim: rgba(23, 11, 26, 0.55);',
    ],
  },
  {
    id: 'glacier', name: '冰川', desc: '冷白 · 钢蓝 · 冰青',
    scheme: 'light',
    neutral: ['#ffffff', '#f4f9fd', '#dbe7f2', '#7f9cba', '#16233a'],
    primary: ['#eef6ff', '#cfe4f7', '#3b82f6', '#1d4ed8', '#172554'],
    accent: ['#effcfd', '#c3f0f4', '#22b8cf', '#0e7490', '#083344'],
    design: [
      '  --radius-sm: 6px;', '  --radius-md: 12px;', '  --radius-lg: 16px;',
      '  --radius-xl: 20px;', '  --radius-2xl: 24px;',
      '  --shadow-sm: 0 0 0 0 transparent;',
      '  --shadow-md: 0 4px 18px rgba(23, 45, 84, 0.10);',
      '  --shadow-lg: 0 12px 36px rgba(23, 45, 84, 0.14);',
      '  --hyacinth-bg-image: none;', '  --hyacinth-surface-blur: none;',
      '  --hyacinth-aurora: radial-gradient(640px 420px at 82% 14%, rgba(59, 130, 246, 0.12), transparent 66%);',
      '  --hyacinth-user-bg-scrim: rgba(255, 255, 255, 0.5);',
    ],
  },
];

// ── ① theme.css：追加主题块 ────────────────────────────────────
let css = fs.readFileSync(CSS, 'utf8');
if (css.includes("data-theme='cyber'")) {
  console.error('✗ theme.css 里已存在 cyber 主题块 ⇒ 中止（避免重复追加 ✗）');
  process.exit(1);
}
const blocks = THEMES.map((t) => {
  const n = scale(t.neutral); const p = scale(t.primary); const a = scale(t.accent);
  return [
    '',
    `/* ── ${t.id}（${t.name} · ${t.desc}）${'─'.repeat(Math.max(1, 46 - t.name.length))} */`,
    `html[data-theme='${t.id}'] {`,
    `  /* 调色板：neutral ${t.scheme === 'light' ? '0=最亮 → 900=最暗（亮色反向 ✓）' : '0=最深 → 900=最亮'} */`,
    emit('neutral', n),
    '',
    emit('primary', p),
    '',
    emit('accent', a),
    '',
    '  /* 设计语言层：这几项决定"风格"而不只是"配色" ✓ */',
    ...t.design,
    '}',
  ].join('\n');
}).join('\n');
css = css.replace(/\s*$/, '\n') + blocks + '\n';
fs.writeFileSync(CSS, css, 'utf8');
console.log('  ✓ theme.css：追加 ' + THEMES.length + ' 个主题块');

// ── ② app.js：THEMES 清单（可见 8 个 = 夜园 + 昼园 + 6 新 ✓）──
const sw = (t) => {
  const n = scale(t.neutral); const p = scale(t.primary); const a = scale(t.accent);
  return [n[50], n[150], p[500], a[500], n[900]];
};
const list = [
  { id: 'hyacinth', name: '夜园', desc: '夜花园 · 萤光花穗', swatches: ['#0f1120', '#161930', '#a78bfa', '#2dd4bf', '#eceefa'] },
  { id: 'light', name: '昼园', desc: '水彩花园 · 清晨', swatches: ['#f6f8f3', '#fdfefc', '#c9baf6', '#43a461', '#1a2016'] },
  ...THEMES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, swatches: sw(t) })),
];
const THEMES_JS = '  const THEMES = [\n' + list.map((t) =>
  `    { id: '${t.id}', name: '${t.name}', desc: '${t.desc}',\n      swatches: [${t.swatches.map((s) => `'${s}'`).join(', ')}] },`).join('\n') + '\n  ];';

let app = fs.readFileSync(APP, 'utf8');
const appFrom = app.match(/  const THEMES = \[[\s\S]*?\n  \];/);
if (!appFrom) { console.error('✗ app.js：没找到 THEMES 数组 ⇒ 中止'); process.exit(1); }
app = app.replace(appFrom[0], THEMES_JS);
fs.writeFileSync(APP, app, 'utf8');
console.log('  ✓ app.js：THEMES 更新为 ' + list.length + ' 个可见主题');

// ── ③ schema 白名单（新 id ＋ 保留旧 id ✓ 兼容）──
const ALL = ['hyacinth', 'light', 'dark', 'glass', 'ink', 'rainy', ...THEMES.map((t) => t.id)];
let sc = fs.readFileSync(SCHEMA, 'utf8');
const scFrom = /theme: 'hyacinth' \| 'light' \| 'dark' \| 'glass' \| 'ink' \| 'rainy';/;
if (!scFrom.test(sc)) { console.error('✗ schema：theme 白名单锚点没命中 ⇒ 中止（未写盘）'); process.exit(1); }
sc = sc.replace(scFrom, `theme: ${ALL.map((id) => `'${id}'`).join(' | ')};`);
fs.writeFileSync(SCHEMA, sc, 'utf8');
console.log('  ✓ config-schema.ts：白名单扩为 ' + ALL.length + ' 个');

// ── 写后自检（照实际写入的文本抄 ✓）──
const cssBack = fs.readFileSync(CSS, 'utf8');
const appBack = fs.readFileSync(APP, 'utf8');
const scBack = fs.readFileSync(SCHEMA, 'utf8');
const checks = [
  [cssBack.includes("html[data-theme='cyber'] {"), true],
  [cssBack.includes("html[data-theme='mono'] {"), true],
  [cssBack.includes('--radius-md: 0px;'), true],
  [appBack.includes("id: 'cyber', name: '赛博朋克'"), true],
  [appBack.includes("id: 'terminal', name: '终端'"), true],
  [appBack.includes("id: 'hyacinth', name: '夜园'"), true],
  [scBack.includes("'cyber' | 'paper' | 'terminal' | 'sunset' | 'glacier'"), true],
];
let bad = 0;
for (const [ok, want] of checks) { if (ok !== want) { console.error('✗ 自检未过：' + (want ? '缺少' : '多余')); bad++; } }
if (bad) { console.error('✗ 自检失败（已写盘，需人工修）'); process.exit(1); }
console.log('✓ 写后自检通过（' + checks.length + ' 项）：新主题 id = ' + THEMES.map((t) => t.id).join(', '));
