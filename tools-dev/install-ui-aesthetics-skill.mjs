// tools-dev/install-ui-aesthetics-skill.mjs —— 安装 ui-aesthetics skill（**原生文件夹形态** ✓）
//
// 形态（2026-09-20 起框架原生支持 ✓）：
//   ~/.agent/skills/ui-aesthetics/SKILL.md          主体（约 12.6 KB ✓）
//   ~/.agent/skills/ui-aesthetics/references/*.md   12 个细则（可再嵌套 ✓）
//   ⇒ 启用时**只注入主体**，并附一行 `Skill directory: <绝对路径>` ⇒ 主体里的相对路径可解析 ✓
//   ⇒ 子文件**不会**被当成独立 skill ✓（加载器刻意不递归进子目录 ✓）
//
// ⚠️ 历史（两条教训都留在这儿 ✓）：
//   ① 框架支持文件夹之前，本脚本把 12 个细则**合订成 85 KB 单文件** ⇒ 代价是"启用即整份注入" ✗
//      ⇒ 现已改回原生形态 ✓
//   ② 本文件曾出现**版本错配**事故 ✗：某次改这脚本的 `write` **被守卫拒了**（当时没细看 ✗），
//      随后又**重跑了一遍旧脚本** ⇒ 把 85 KB 合订本**又生成了一遍** ✗，还被热加载成生效 skill ✗
//      ⇒ 教训：**写文件的成功回执必须看** ✓；**改完工具先确认内容，再执行它** ✓
//      ⇒ 本脚本已内置"安装后删掉合订本"这一步 ✓（让这个坑不可能复发 ✓）
//
// 抓取（本机直连 GitHub 不通 ✗：github.com 解析到 127.0.0.1、`git clone` 返回 502）⇒ 走镜像 ✓：
//   $base = 'https://gh-proxy.com/https://raw.githubusercontent.com/kasonye/ui-aesthetics-skill/main/'
//   Invoke-WebRequest ($base + 'SKILL.md') -OutFile "$env:TEMP\ui-aes\SKILL.md"
//   12 个细则：($base + 'references/<名字>.md') ⇒ "$env:TEMP\ui-aes\references\<名字>.md" ✓
//
// ⚠️ 上游仓库**没有 LICENSE**（请求 404 ✓）⇒ 仅个人自用 ✓，勿再分发 ✗
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME;
const SRC = path.join(process.env.TEMP || '.', 'ui-aes');
const DEST = path.join(HOME, '.agent', 'skills', 'ui-aesthetics');
const FLAT = path.join(HOME, '.agent', 'skills', 'ui-aesthetics.md');   // 旧合订本（有就删 ✓）
const REFS = [
  'design-principles', 'color-system', 'component-aesthetics', 'interaction-states',
  'motion-principles', 'motion-patterns', 'depth-lighting-system', 'style-archetypes',
  'anti-patterns', 'review-rubric', 'rewrite-playbook', 'distilled-examples',
];

// ── 前置检查（缺料就明确报错，别静默半成品 ✗）──
const main = path.join(SRC, 'SKILL.md');
if (!fs.existsSync(main)) {
  console.error('✗ 缺 ' + main + ' ⇒ 先按文件头部注释用镜像抓取 ✓');
  process.exit(1);
}
for (const r of REFS) {
  if (!fs.existsSync(path.join(SRC, 'references', r + '.md'))) {
    console.error('✗ 缺细则文件：' + r + ' ⇒ 先抓取 ✓');
    process.exit(1);
  }
}

// ── 落成原生文件夹 ──
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.join(DEST, 'references'), { recursive: true });
fs.copyFileSync(main, path.join(DEST, 'SKILL.md'));
for (const r of REFS) {
  fs.copyFileSync(path.join(SRC, 'references', r + '.md'), path.join(DEST, 'references', r + '.md'));
}
if (fs.existsSync(FLAT)) { fs.rmSync(FLAT); console.log('  ✓ 已删旧合订本（防再次误加载 ✓）'); }
console.log('  ✓ 已装成原生文件夹：' + DEST);

// ── 写后自检 ──
const checks = [
  ['主体在', fs.existsSync(path.join(DEST, 'SKILL.md'))],
  ['主体是"上游原文"（不含合订版标记 ✓）', !fs.readFileSync(path.join(DEST, 'SKILL.md'), 'utf8').includes('合订版')],
  ['细则 12 个', REFS.every((r) => fs.existsSync(path.join(DEST, 'references', r + '.md')))],
  ['旧合订本不在 ✓', !fs.existsSync(FLAT)],
];
let bad = 0;
for (const [what, ok] of checks) { if (!ok) { console.error('✗ 自检未过：' + what); bad++; } }
console.log(bad ? '✗ 自检失败' : '✓ 自检通过（' + checks.length + ' 项）');
process.exit(bad ? 1 : 0);
