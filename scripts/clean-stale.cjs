// scripts/clean-stale.cjs —— 清掉 dist 里「源文件已删、编译产物还在」的残骸（构建卫生 ✓）
//
// 为什么需要（2026-09-20 实况 ✗）：
//   tsc（含 incremental）**不会**删除「源文件已消失」的旧产物 ⇒ dist 里会留着已删模块的
//   .js / .d.ts。这些残骸会被**运行时动态发现**捡起来 —— 当天真出了一次事：
//   已删除的 webui 渠道插件 .js 仍留在 dist ⇒ 被 discoverPlugins 当插件又注册了一遍 ✗
//   （两个同 id 渠道互相替换，谁赢取决于注册顺序 ⇒ 行为不可预期 ✓）
//
// 判据（保守：**只删确实找不到源**的）：
//   dist/<rel>.js        ← src/<rel>.{ts,tsx} 或 src/<rel>.js（同名复制型资产 ✓）
//   dist/<rel>.d.ts      ← src/<rel>.{ts,tsx}
//   *.js.map / *.d.ts.map 与其宿主同判
//   跳过 dist/{grammars,webui,prompts}（复制型资产：wasm / 静态页 / 提示词 ✓）
//
// 用法：node scripts/clean-stale.cjs         清理并报告
//       node scripts/clean-stale.cjs --check 只报告；有残骸则 exit 1（可当门禁 ✓）
//
// 校验依据（2026-09-20）：与「临时 outDir 全量重建」逐文件比对，残骸数完全一致（62 ✓）
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');
const SUFFIXES = ['.d.ts.map', '.js.map', '.d.ts', '.js'];
const SKIP_TOP = new Set(['grammars', 'webui', 'prompts']);
const checkOnly = process.argv.includes('--check');

/** 该产物路径对应的可能源文件（含"同名复制"型 ✓） */
function srcCandidates(rel) {
  let base = rel;
  for (const s of SUFFIXES) {
    if (rel.endsWith(s)) { base = rel.slice(0, -s.length); break; }
  }
  return [
    path.join(SRC, base + '.ts'),
    path.join(SRC, base + '.tsx'),
    path.join(SRC, rel),
  ];
}
const hasSource = (rel) => srcCandidates(rel).some((p) => fs.existsSync(p));

const stale = [];
function walk(dir, rel) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (!rel && SKIP_TOP.has(e.name)) continue;
      walk(path.join(dir, e.name), r);
      continue;
    }
    if (!SUFFIXES.some((s) => e.name.endsWith(s))) continue;
    if (!hasSource(r)) stale.push(r);
  }
}
if (fs.existsSync(DIST)) walk(DIST, '');

if (stale.length === 0) {
  console.log('  ✓ dist 无残骸（源文件与产物一致 ✓）');
  process.exit(0);
}
if (checkOnly) {
  console.log('  ✗ 发现 ' + stale.length + ' 个残骸：');
  for (const r of stale.slice(0, 20)) console.log('      - ' + r);
  if (stale.length > 20) console.log('      …（其余 ' + (stale.length - 20) + ' 个）');
  process.exit(1);
}
for (const r of stale) {
  try { fs.rmSync(path.join(DIST, r), { force: true }); } catch { /* 忽略单点失败 ✓ */ }
}
console.log('  ✓ 已清理 ' + stale.length + ' 个残骸（源文件已删、产物残留 ✗）');
for (const r of stale.slice(0, 8)) console.log('      - ' + r);
if (stale.length > 8) console.log('      …（其余 ' + (stale.length - 8) + ' 个）');