#!/usr/bin/env node
/**
 * gen-desktop-icon —— 生成桌面壳的应用图标（desktop/native-shell/app.ico）
 *
 * 「用代码画一个」：不引入任何图片资产，图标是本脚本里的参数化 SVG
 * （一朵风信子 —— 项目名 Hyacinth 🪻 的本体），经 sharp（librsvg）逐尺寸
 * 光栅化后手工组装成多尺寸 .ico。改配色 / 花序布局只需改本文件重跑。
 *
 * 设计约束：
 *  - 底色与 WebUI --neutral-0（#0A0B14）同源，标题栏/页面/图标三者无色差；
 *  - 花色以品牌紫 --primary-500（#A78BFA）为基准做明暗梯度：底部花开大而亮、
 *    顶部花苞小而深 —— 风信子花序的真实形态（下开上苞），不是随机圆点堆；
 *  - 小尺寸（16/24，托盘用）必须仍可辨认 ⇒ 全部用实心形状、无细描边，
 *    靠两色花瓣+深色花心制造层次（描边在小尺寸会糊掉）。
 *
 * 产物：
 *  - desktop/native-shell/app.ico（16/24/32/48/64/128/256 七档，PNG 压缩条目）
 *  - .tmp-icon/preview-*.png 预览（gitignore 覆盖，仅供人工核对）
 *
 * .ico 容器格式（Vista+ PNG-in-ICO）：ICONDIR(6B) + N×ICONDIRENTRY(16B) + PNG 数据。
 * WinForms / dotnet publish / Windows 资源管理器均接受；256 档的宽高字段写 0。
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const repo = path.join(__dirname, '..');
const outIco = path.join(repo, 'desktop', 'native-shell', 'app.ico');
const previewDir = path.join(repo, '.tmp-icon');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const VB = 256; // viewBox 边长

// ── 配色（与 WebUI theme.css 同源）─────────────────────────────────
const BG_TOP = '#1A1D38';        // 底色微亮渐变顶（深靛）
const BG_BOTTOM = '#0A0B14';    // --neutral-0
const GLOW = '#7C5CFF';          // 花序背后的柔光
const STEM = '#5B9A6E';          // 花茎绿
const LEAF_DARK = '#2C5A3F';
const LEAF_LIGHT = '#3E7D57';
// 花序明暗梯度：底部（开得最透，最亮）→ 顶部花苞（最深）
const FLOWER_ROWS = [
  // y    花心列表 [dx, r]，dx 相对中轴 128。底部两档横向收得更紧：
  // 花间不留缝（真实花序是密簇，散开像"三朵花摆造型"）
  { y: 141, flowers: [[-25, 15.5], [0, 16.5], [25, 15.5]], petals: '#D5C8FF', core: '#8E6FE8' },
  { y: 118, flowers: [[-33, 13.5], [0, 15], [33, 13.5]], petals: '#C4B3FC', core: '#7D5EE6' },
  { y: 96, flowers: [[-31, 12], [0, 13.5], [31, 12]], petals: '#A78BFA', core: '#6D4FD0' }, // 品牌紫在这一档
  { y: 75, flowers: [[-21, 10], [0, 11.5], [21, 10]], petals: '#9070F2', core: '#5B3FC0' },
  { y: 56, flowers: [[-12, 8.2], [0, 9.5], [12, 8.2]], petals: '#7E5EE8', core: '#4E35B4' },
  // 顶两档是花苞：整颗圆，没有张开的花瓣
  { y: 40, buds: [[-10, 6.6], [0, 7.6], [10, 6.6]], color: '#6A4BD4' },
  { y: 28, buds: [[0, 5.6]], color: '#5939C4' },
];

/** 一朵小花：6 片椭圆花瓣绕心旋转 60° 步进 + 深色花心。全实心，不用描边。 */
function floret(cx, cy, r, petal, core) {
  let s = '';
  for (let k = 0; k < 6; k++) {
    const a = k * 60;
    s += `<ellipse cx="0" cy="${(-r * 0.62).toFixed(2)}" rx="${(r * 0.36).toFixed(2)}" ry="${(r * 0.55).toFixed(2)}" fill="${petal}" transform="translate(${cx.toFixed(2)},${cy.toFixed(2)}) rotate(${a})"/>`;
  }
  s += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(r * 0.24).toFixed(2)}" fill="${core}"/>`;
  return s;
}

function buildSvg() {
  let flowers = '';
  for (const row of FLOWER_ROWS) {
    if (row.flowers) {
      for (const [dx, r] of row.flowers) flowers += floret(128 + dx, row.y, r, row.petals, row.core);
    }
    if (row.buds) {
      for (const [dx, r] of row.buds) {
        flowers += `<circle cx="${128 + dx}" cy="${row.y}" r="${r}" fill="${row.color}"/>`;
        // 苞尖一点高光，让最上面两档在缩到 16px 时仍与花簇区分出"上深下亮"的朝向
        flowers += `<circle cx="${(128 + dx - r * 0.3).toFixed(2)}" cy="${(row.y - r * 0.3).toFixed(2)}" r="${(r * 0.22).toFixed(2)}" fill="#8F79E8" opacity="0.7"/>`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/>
      <stop offset="1" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.4" r="0.42">
      <stop offset="0" stop-color="${GLOW}" stop-opacity="0.30"/>
      <stop offset="1" stop-color="${GLOW}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="leafL" x1="1" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${LEAF_DARK}"/>
      <stop offset="1" stop-color="${LEAF_LIGHT}"/>
    </linearGradient>
    <linearGradient id="leafR" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="${LEAF_DARK}"/>
      <stop offset="1" stop-color="${LEAF_LIGHT}"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${VB}" height="${VB}" rx="58" fill="url(#bg)"/>
  <rect x="0" y="0" width="${VB}" height="${VB}" rx="58" fill="url(#glow)"/>

  <!-- 叶：两片内弯的披针形，从茎基部张出去，尖端收在花序宽度之外 -->
  <path d="M 126 226 C 96 218 68 200 54 164 C 82 178 108 198 126 214 Z" fill="url(#leafL)"/>
  <path d="M 130 230 C 158 226 186 210 200 176 C 174 188 148 204 130 218 Z" fill="url(#leafR)"/>

  <!-- 茎：轻微的 S 弯（真花不会笔直如尺），从花序底部到圆角矩形下缘附近 -->
  <path d="M 128 148 C 125 176 131 204 128 236" fill="none" stroke="${STEM}" stroke-width="9" stroke-linecap="round"/>

  ${flowers}
</svg>`;
}

/** 组装多尺寸 .ico（PNG 条目，Vista+ 格式）。 */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type = icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map((png, i) => {
    const s = SIZES[i];
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;           // 宽（256 写 0）
    e[1] = s >= 256 ? 0 : s;           // 高
    e[2] = 0; e[3] = 0;                // 调色板数 / reserved
    e.writeUInt16LE(1, 4);             // planes
    e.writeUInt16LE(32, 6);            // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

(async () => {
  const svg = buildSvg();

  // 逐尺寸**原生**光栅化：不先渲 256 再缩（那样 16px 会糊）。
  // 无固定 width/height 的 SVG 按 density 渲染，density = 72 × 目标/viewBox。
  const pngs = await Promise.all(SIZES.map(async (s) => {
    const density = Math.round((72 * s) / VB);
    return sharp(Buffer.from(svg), { density }).resize(s, s).png().toBuffer();
  }));

  fs.mkdirSync(path.dirname(outIco), { recursive: true });
  fs.writeFileSync(outIco, buildIco(pngs));
  console.log(`[gen-desktop-icon] ${outIco} (${(fs.statSync(outIco).size / 1024).toFixed(1)} KB, ${SIZES.join('/')}px)`);

  // 预览（不进 git；给人看的大图 + 托盘真实尺寸小图）
  fs.mkdirSync(previewDir, { recursive: true });
  for (const s of [256, 48, 32, 16]) {
    const density = Math.round((72 * s) / VB);
    const buf = await sharp(Buffer.from(svg), { density }).resize(s, s).png().toBuffer();
    fs.writeFileSync(path.join(previewDir, `preview-${s}.png`), buf);
  }
  console.log(`[gen-desktop-icon] previews → ${previewDir}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
