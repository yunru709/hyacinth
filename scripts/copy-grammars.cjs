#!/usr/bin/env node
/**
 * copy-grammars.cjs —— 语法 wasm 的「入库 + 自证」脚本（设计稿 v2.2 条件 ①/③ 的落地）
 *
 * 做什么：把各语言的语法 wasm 从 node_modules（精确锁版本 + devDependency）复制进
 * dist/grammars/，并用 scripts/grammars.sha256.json 逐项校验 sha256。
 *
 * 为什么有清单：本方案选择"信任官方产物"（不自己构建 wasm）—— 代价的**对冲**就是把每个
 * 产物的哈希钉进仓库：官方包重发版、或本地 node_modules 被换掉，**构建立刻失败**，
 * 而不是悄悄换掉运行时解析出来的语法树。（这正是设计稿把"6/8 自带 wasm"从口头数字
 * 变成代码里自证事实的方式。）
 *
 * 用法：
 *   node scripts/copy-grammars.cjs            校验 + 复制；清单缺项或哈希不符 → 非零退出
 *   node scripts/copy-grammars.cjs --update   重新生成清单（仅当确实换了语法包版本时跑，
 *                                             其 diff 必须进 review）
 *
 * 覆盖面：只列**确认自带 .wasm** 的语言。kotlin / swift 官方包不含 wasm（本地实测 8 门中
 * 6 门自带），按设计稿 v2.2 暂走正则兜底，自建管线留作备选路径。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'grammars');
const MANIFEST = path.join(ROOT, 'scripts', 'grammars.sha256.json');
const update = process.argv.includes('--update');

/** 语言 → 语法包。**加一门语言 = 这里加一行**（包须已精确锁进 devDependencies） */
const GRAMMARS = [
  { language: 'python', pkg: 'tree-sitter-python', wasm: 'tree-sitter-python.wasm' },
  { language: 'go', pkg: 'tree-sitter-go', wasm: 'tree-sitter-go.wasm' },
  { language: 'rust', pkg: 'tree-sitter-rust', wasm: 'tree-sitter-rust.wasm' },
  { language: 'java', pkg: 'tree-sitter-java', wasm: 'tree-sitter-java.wasm' },
  { language: 'c', pkg: 'tree-sitter-c', wasm: 'tree-sitter-c.wasm' },
  { language: 'cpp', pkg: 'tree-sitter-cpp', wasm: 'tree-sitter-cpp.wasm' },
  // kotlin / swift：官方包**不含** wasm → 正则兜底（v2.2 备选路径：自建管线）
];

function resolveWasm(g) {
  // 用包根推导，避免 require('<pkg>/package.json') 被 exports 拦（web-tree-sitter 就会拦）
  const pkgJson = require.resolve(`${g.pkg}/package.json`);
  return path.join(path.dirname(pkgJson), g.wasm);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const next = {};
const problems = [];

fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`语法 wasm 入库${update ? '（--update：重建清单）' : ''}`);
for (const g of GRAMMARS) {
  let src;
  try {
    src = resolveWasm(g);
  } catch {
    problems.push(`${g.language}: 找不到语法包 ${g.pkg}（是否已精确锁进 devDependencies？）`);
    continue;
  }
  if (!fs.existsSync(src)) {
    problems.push(`${g.language}: 包里没有 ${g.wasm}`);
    continue;
  }

  const hash = sha256(src);
  const bytes = fs.statSync(src).size;
  const recorded = manifest[g.language]?.sha256;

  if (recorded && recorded !== hash && !update) {
    problems.push(
      `${g.language}: sha256 不符 ✗\n    清单: ${recorded}\n    实得: ${hash}\n` +
        `    ⇒ 语法包产物变了。若确属有意升级，跑 --update 重建清单并让 diff 进 review。`,
    );
    continue;
  }
  if (!recorded && !update) {
    problems.push(
      `${g.language}: 清单里没有该项（首次入库请跑 --update 生成，并 review 其 diff）`,
    );
    continue;
  }

  const dest = path.join(OUT_DIR, g.wasm);
  fs.copyFileSync(src, dest);
  next[g.language] = { pkg: g.pkg, wasm: g.wasm, bytes, sha256: hash };
  console.log(`  ✓ ${g.language.padEnd(8)} ${(bytes / 1024).toFixed(1).padStart(8)} kB  ${hash.slice(0, 16)}…  → dist/grammars/`);
}

if (problems.length > 0) {
  console.error('\n❌ 语法 wasm 校验失败：');
  for (const p of problems) console.error(`   - ${p}`);
  process.exit(1);
}

if (update) {
  fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`\n✓ 已写入清单 scripts/grammars.sha256.json（${Object.keys(next).length} 项）`);
}
console.log(`✅ ${Object.keys(next).length} 个语法 wasm 已就位`);
