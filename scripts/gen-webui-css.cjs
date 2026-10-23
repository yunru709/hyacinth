#!/usr/bin/env node
/* 编译 WebUI 的 Tailwind 样式
 * ───────────────────────────────────────────────────────────
 * 输入  src/webui/tailwind.input.css
 * 输出  src/webui/vendor/tailwind.css
 *
 * 用法：node scripts/gen-webui-css.cjs
 *
 * 为什么要写这个脚本而不是直接跑 npx：
 *   Tailwind 在本项目里**不是运行时依赖**（产物是提交进仓库的静态 CSS），
 *   所以不能假设 node_modules 里有 @tailwindcss/cli。这里按「本地 → 全局 → 报错」
 *   三级查找，并给出可执行的安装命令，避免 CI 里静默产出一份空样式。
 *
 * 校验：编译完成后会检查产物里是否包含三条关键规则（preflight、body 底色、
 *   表格换行），缺任何一条就非零退出 —— 防止"编出来了但正是空的那份"。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INPUT = path.join(ROOT, 'src', 'webui', 'tailwind.input.css');
const OUTPUT = path.join(ROOT, 'src', 'webui', 'vendor', 'tailwind.css');

function findCli() {
  // 0) 显式指定：TAILWIND_CLI=/path/to/@tailwindcss/cli/dist/index.mjs
  //    给"本机别处装了一份、但不想进 package.json"的场景留个出口。
  if (process.env.TAILWIND_CLI) {
    const p = process.env.TAILWIND_CLI;
    if (!fs.existsSync(p)) {
      console.error(`✗ TAILWIND_CLI 指向的文件不存在：${p}`);
      process.exit(1);
    }
    return p;
  }
  // 1) 项目内安装
  try {
    return require.resolve('@tailwindcss/cli/dist/index.mjs', { paths: [ROOT] });
  } catch { /* 继续找 */ }
  // 2) 直接落在 node_modules 但 require.resolve 被 exports 挡住的情况
  const guesses = [
    path.join(ROOT, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs'),
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return null;
}

function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`✗ 找不到输入文件：${INPUT}`);
    process.exit(1);
  }

  const cli = findCli();
  if (!cli) {
    console.error(
      '✗ 没找到 @tailwindcss/cli。\n' +
      '  产物 src/webui/vendor/tailwind.css 是提交进仓库的静态文件，\n' +
      '  只有在需要改 src/webui/tailwind.input.css 时才要重新生成。\n' +
      '  安装：npm i -D @tailwindcss/cli@4\n' +
      '  或临时：npx --yes @tailwindcss/cli@4 -i src/webui/tailwind.input.css -o src/webui/vendor/tailwind.css',
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const r = spawnSync(process.execPath, [cli, '-i', INPUT, '-o', OUTPUT], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('✗ Tailwind 编译失败');
    process.exit(r.status || 1);
  }

  // 产物完整性校验：三条规则分别对应 preflight、@theme 消费、@layer base 的 @apply
  const css = fs.readFileSync(OUTPUT, 'utf8');
  const must = [
    ['preflight', /box-sizing:\s*border-box/],
    ['body 底色', /background:\s*var\(--hyacinth-background\)/],
    ['表格换行', /word-break:\s*auto-phrase/],
  ];
  const missing = must.filter(([, re]) => !re.test(css)).map(([n]) => n);
  if (missing.length) {
    console.error(`✗ 产物缺少关键规则：${missing.join('、')}`);
    process.exit(1);
  }

  console.log(`✓ ${path.relative(ROOT, OUTPUT)}  ${(css.length / 1024).toFixed(1)} KB`);
}

main();
