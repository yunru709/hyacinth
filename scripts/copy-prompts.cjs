// Copy prompts from src to dist (cross-platform)
const fs = require('fs');
const path = require('path');
const os = require('os');

function cp(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const sp = path.join(src, f);
    const dp = path.join(dst, f);
    fs.statSync(sp).isDirectory() ? cp(sp, dp) : fs.copyFileSync(sp, dp);
  }
}

// ── 反向清理：删掉 dist/prompts 里「src/prompts 已无对应源」的残骸 ──
// 为什么需要（2026-10-08 实况 ✗）：prompts 是复制型资产 —— tsc 不管它，
// clean-stale.cjs 又显式跳过 prompts（SKIP_TOP）⇒ 源删了产物仍留在 dist/prompts
// ⇒ loadPrompt 的**内置兜底**照样能读到它（死提示词长期滞留）。
// 判据与 clean-stale 同源：先认「同名源」，再认「tsc 产物」（去后缀后同名 .ts 在）。
const SRC_PROMPTS = 'src/prompts';
const DIST_PROMPTS = 'dist/prompts';
const TS_SUFFIXES = ['.d.ts.map', '.js.map', '.d.ts', '.js'];

function hasSource(rel) {
  if (fs.existsSync(path.join(SRC_PROMPTS, rel))) return true;
  for (const s of TS_SUFFIXES) {
    if (rel.endsWith(s)) {
      return fs.existsSync(path.join(SRC_PROMPTS, rel.slice(0, -s.length) + '.ts'));
    }
  }
  return false;
}

function prune(distDir, rel = '') {
  const removed = [];
  for (const f of fs.readdirSync(distDir)) {
    const r = rel ? rel + '/' + f : f;
    const dp = path.join(distDir, f);
    if (fs.statSync(dp).isDirectory()) {
      if (hasSource(r)) removed.push(...prune(dp, r));
      else { fs.rmSync(dp, { recursive: true, force: true }); removed.push(r + '/'); }
      continue;
    }
    if (!hasSource(r)) { fs.rmSync(dp, { force: true }); removed.push(r); }
  }
  return removed;
}

if (fs.existsSync(DIST_PROMPTS)) {
  const pruned = prune(DIST_PROMPTS);
  if (pruned.length > 0) {
    console.log('  已清理 dist/prompts 残骸 ' + pruned.length + ' 项（源已删、产物残留 ✗）:');
    for (const r of pruned.slice(0, 10)) console.log('      - ' + r);
  }
}

cp(SRC_PROMPTS, DIST_PROMPTS);
cp('src/tools/builtin', path.join(os.homedir(), '.agent', 'tools'));
// TTS 推理胶水（python 资产，tsc 不编译）：src/tts/engines → dist/tts/engines。
// 漏拷的实况（2026-10-24 ✗）：serve 的 tts.start 报「推理脚本缺失」——
// dist 里从来没有 server.py，此前从未真正跑通过服务启动路径。
cp('src/tts/engines', 'dist/tts/engines');
console.log('Builtin Python tools copied to ~/.agent/tools');
console.log('Prompts copied to dist/prompts');
console.log('TTS engine scripts copied to dist/tts/engines');
