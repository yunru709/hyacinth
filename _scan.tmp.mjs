// 临时扫描：硬编码路径 / 本机专属 / 敏感信息（用完删，*.tmp.mjs 已被 .npmignore 排除）
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'scripts', 'dist'];
const ROOT_FILES = ['package.json', 'commands.json', 'pnpm-workspace.yaml', 'start-webui.sh', 'hyacinth-desktop.cmd', '.npmignore', 'tsconfig.json', 'vitest.config.ts', 'README.md'];
const EXTS = new Set(['.ts', '.js', '.cjs', '.mjs', '.json', '.md', '.ps1', '.sh', '.cmd', '.html', '.css', '.yml', '.yaml']);

const patterns = [
  { name: 'WIN_ABS_PATH', re: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?![\\/])/g },
  { name: 'UNIX_HOME', re: /\/(Users|home)\/[A-Za-z0-9._-]+/g },
  { name: 'USERNAME_74689', re: /74689/g },
  { name: 'LOCAL_ONLY_DIR', re: /Desktop[\\/]Agent|Python311|FreeCAD|D:[\\/]{1,2}VM|agent[\\/]{1,2}work|F:[\\/]{1,2}(Git|FreeCAD)|hyacinth-架构报告/i },
  { name: 'SECRET', re: /sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: 'PRIVATE_IP', re: /192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}/g },
];

const hits = [];
function check(file, txt) {
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      p.re.lastIndex = 0;
      if (p.re.test(lines[i])) {
        hits.push({ kind: p.name, file, line: i + 1, text: lines[i].trim().slice(0, 150) });
      }
    }
  }
}
function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', '.tmp-icon', 'grammars', 'skills', 'prompts'].includes(e.name)) continue;
      walk(p);
    } else if (EXTS.has(path.extname(e.name).toLowerCase())) {
      try { check(p.replace(/\\/g, '/'), fs.readFileSync(p, 'utf8')); } catch {}
    }
  }
}
for (const r of ROOTS) walk(r);
for (const f of ROOT_FILES) { try { check(f, fs.readFileSync(f, 'utf8')); } catch {} }

// 按 kind 分组统计
const byKind = {};
for (const h of hits) byKind[h.kind] = (byKind[h.kind] || 0) + 1;
console.log('=== TOTAL:', hits.length, '===');
for (const k of Object.keys(byKind)) console.log(`${k}: ${byKind[k]}`);
console.log('=== DETAIL (excluding test files, top 60) ===');
const nonTest = hits.filter(h => !/\.test\.[tj]s$/.test(h.file));
console.log('nonTest total:', nonTest.length);
for (const h of nonTest.slice(0, 60)) console.log(`${h.kind} | ${h.file}:${h.line} | ${h.text}`);
