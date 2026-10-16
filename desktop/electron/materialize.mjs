#!/usr/bin/env node
// ============================================================
// 物化 pnpm 依赖树 —— 把 .pnpm 符号链接农场解引用成真实文件
// ============================================================
// 背景（为什么需要这个）：
//   pnpm 的 node_modules 是**绝对路径链接农场**（node_modules/@x/y -> C:\...\node_modules\.pnpm\...）
//   直接拷包必断链（实测：拷到 F: 后 ERR_MODULE_NOT_FOUND '@clack/core'）。
//   `pnpm deploy --filter` 在本仓会联网重解析整个图（实测卡 600s 被 kill）⇒ 不可用。
//
// 做法：从**已装好的真实仓库**出发，做两件事：
//   1) 遍历 node_modules 顶层，把每个 Junction/Symlink 解引用 → 复制真实目录内容
//   2) 同时把 .pnpm/<pkg>@<ver>/node_modules/ 下所有包的**传递依赖**也展平复制
//      （hoisted 布局：所有包平铺到同一层 node_modules，Node 解析规则天然支持）
//
// 为什么 hoisted 可行：Node 的 ESM/CJS 解析是「向上逐级找 node_modules」，
//   平铺后任一包都能在顶层 node_modules 直接命中自己的依赖（只要无版本冲突）。
//   有版本冲突的场景（同包多版本）极少，遇冲突保留先到者并记警告 —— 由后续冒烟测试暴露。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径基准 = **仓库自身**（2026-10-17 孑遗指正：GUI 与 tui / webui 是**平行** UI，
// 配方不该指向仓库外的临时目录）。因此两个参数都给仓库相对的默认值，裸跑即可。
// 用法：node desktop\electron\materialize.mjs [REPO] [OUT]
//   默认 REPO = 本脚本目录往上两级（= 仓库根）；OUT = <本脚本目录>\stage\app（已 gitignore）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[2] || path.resolve(HERE, '..', '..');
const OUT = process.argv[3] || path.join(HERE, 'stage', 'app');

const srcRoot = path.join(REPO, 'node_modules');
const dstRoot = path.join(OUT, 'node_modules');
const pnpmDir = path.join(srcRoot, '.pnpm');

const stats = { copied: 0, skipped: 0, conflicts: [], linksBroken: 0 };
const seen = new Set(); // 已放置的包名（顶层）

function log(...a) { console.log('[materialize]', ...a); }

/** 递归复制目录，跳过 .pnpm 内部链接源（我们单独处理），解引用所有链接 */
function copyTree(src, dst, depth) {
  if (depth > 40) { log('深度超限，跳过', src); return; }
  let st;
  try { st = fs.lstatSync(src); } catch { stats.linksBroken++; return; }

  if (st.isSymbolicLink()) {
    // 解引用：读目标再复制（这是"物化"的核心一步）
    let real;
    try { real = fs.realpathSync(src); } catch { stats.linksBroken++; return; }
    return copyTree(real, dst, depth + 1);
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    let entries;
    try { entries = fs.readdirSync(src); } catch { return; }
    for (const e of entries) copyTree(path.join(src, e), path.join(dst, e), depth + 1);
    return;
  }
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    stats.copied++;
    return;
  }
}

/** 判断是不是 package 目录（有 package.json） */
function isPkgDir(d) {
  try { return fs.existsSync(path.join(d, 'package.json')); } catch { return false; }
}

/**
 * 放置一个包：从 src 复制到 dstRoot/<name>。
 * 冲突策略：已存在则跳过（保留先到者），记入 conflicts 供人工核查。
 */
function placePkg(name, src, tag) {
  // 包名可能是 @scope/name
  const dst = path.join(dstRoot, ...name.split('/'));
  if (seen.has(name)) { stats.skipped++; return; }
  if (fs.existsSync(path.join(dst, 'package.json'))) {
    // 顶层已有同名包；比对版本，不同则记冲突
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dst, 'package.json'), 'utf8')).version;
      const b = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
      if (a !== b) stats.conflicts.push(`${name}: kept ${a}, skipped ${b} (${tag})`);
    } catch { /* noop */ }
    stats.skipped++;
    return;
  }
  seen.add(name);
  copyTree(src, dst, 0);
  log('+', name, tag);
}

fs.mkdirSync(dstRoot, { recursive: true });

// ── 第 0 步：把后端**负载本体**放进 OUT（dist / plugins / package.json）──
// ⚠️ 这一步原先缺失（子代理当时是手工补的）⇒ OUT 里只有 node_modules，build-package.ps1 会因
//    缺 dist 直接 throw（2026-10-17 实测）。它属于"物化"：否则配方不完整、换台机器重建不出来。
function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}
for (const item of ['dist', 'plugins', 'package.json']) {
  const src = path.join(REPO, item);
  if (!fs.existsSync(src)) { log(`! 缺少 ${src}（跳过）`); continue; }
  const dst = path.join(OUT, item);
  if (fs.statSync(src).isDirectory()) copyDir(src, dst); else fs.copyFileSync(src, dst);
  log('+ 负载', item);
}
if (!fs.existsSync(path.join(OUT, 'dist', 'index.js'))) {
  log('❌ OUT 里没有 dist/index.js —— 先在仓库根跑 pnpm run build');
  process.exit(1);
}

// ── 第 1 步：顶层 node_modules 的每个符号链接（含 @scope 目录）解引用 ──
function walkTop(dir, prefix) {
  for (const e of fs.readdirSync(dir)) {
    if (e === '.pnpm' || e === '.bin' || e.startsWith('.')) continue;
    const p = path.join(dir, e);
    const st = fs.lstatSync(p);
    const name = prefix ? `${prefix}/${e}` : e;
    if (st.isSymbolicLink()) {
      const real = fs.realpathSync(p);
      if (isPkgDir(real)) placePkg(name, real, 'top');
    } else if (st.isDirectory() && e.startsWith('@')) {
      walkTop(p, e); // scope 目录，下钻一层
    }
  }
}
walkTop(srcRoot, '');

// ── 第 2 步：.pnpm/<pkg>@<ver>/node_modules/** 里的**传递依赖**全部展平 ──
// .pnpm 的目录名形如 sharp@0.35.0、@img+sharp-win32-x64@0.35.0
const pnpmEntries = fs.readdirSync(pnpmDir);
let scanned = 0;
for (const pe of pnpmEntries) {
  const inner = path.join(pnpmDir, pe, 'node_modules');
  if (!fs.existsSync(inner)) continue;
  scanned++;
  // inner 下既有包本身，也有它的依赖（含 @scope）
  for (const e of fs.readdirSync(inner)) {
    if (e === '.bin' || e.startsWith('.')) continue;
    const p = path.join(inner, e);
    const st = fs.lstatSync(p);
    if (e.startsWith('@') && !st.isSymbolicLink()) {
      // scope 目录：里面每个子目录是一个包
      for (const sub of fs.readdirSync(p)) {
        const sp = path.join(p, sub);
        const sst = fs.lstatSync(sp);
        if (sst.isSymbolicLink()) {
          const real = fs.realpathSync(sp);
          if (isPkgDir(real)) placePkg(`${e}/${sub}`, real, 'dep');
        } else if (isPkgDir(sp)) {
          placePkg(`${e}/${sub}`, sp, 'dep');
        }
      }
      continue;
    }
    if (st.isSymbolicLink()) {
      const real = fs.realpathSync(p);
      if (isPkgDir(real)) placePkg(e, real, 'dep');
    } else if (isPkgDir(p)) {
      placePkg(e, p, 'dep');
    }
  }
}
log(`.pnpm 目录扫描 ${scanned} 个`);

// ── 汇总 ──
log('========== 结果 ==========');
log('复制文件数 =', stats.copied);
log('跳过（重复）=', stats.skipped);
log('断链 =', stats.linksBroken);
log('顶层包数 =', seen.size);
if (stats.conflicts.length) {
  log('版本冲突（保留先到者）:');
  for (const c of stats.conflicts.slice(0, 80)) log('  !', c);
  log(`  共 ${stats.conflicts.length} 条`);
} else {
  log('无版本冲突');
}
fs.writeFileSync(path.join(OUT, '.materialize-report.json'),
  JSON.stringify({ ...stats, packages: [...seen] }, null, 2));
log('报告 ->', path.join(OUT, '.materialize-report.json'));
