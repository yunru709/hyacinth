#!/usr/bin/env node
// ============================================================
// gen-highlight.cjs — 构建 WebUI 用的语法高亮引擎（highlight.js 裁剪版）
// ============================================================
//
// 用法：node scripts/gen-highlight.cjs
// 产物：src/webui/vendor/hljs.min.js（IIFE，挂到 window.hljs）
//
// 为什么不直接引官方 build：官方 highlight.min.js 打包 ~190 种语言（~230KB），
// 聊天里真正出现的就十几种。lucide(388KB) + katex(267KB) 已经把首屏压得很沉，
// 这里只注册 LANGS 列出的子集，并且**运行时按需加载**（见 src/webui/highlight.js）。
//
// 为什么不用 esbuild 打包而手写 CJS 装配：
//   本机沙箱里 esbuild 的 Go 子进程**读不了任何文件**（winapi error #5），
//   连项目自己的 src/webui/markdown.js 都读不了 —— bundle 这条路走不通。
//   好在 hljs 的 lib/ 是纯 CJS，且 core 与各语言模块**零 require**（实测
//   `require(` 计数全为 0），把每个模块塞进独立的函数作用域即可，不需要真 bundler。
//   压缩仍交给 esbuild，但用的是 `transform(字符串)` —— 只走内存，不碰文件系统。
//
// ⚠️ 改语言清单后必须重跑本脚本；产物是构建期快照，不跟随 node_modules。
// ============================================================

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const HLJS = path.join(__dirname, '..', 'node_modules', 'highlight.js');

/** [语言模块名, 额外注册的别名] —— 别名必须显式注册，registerLanguage 只登记主名 */
const LANGS = [
  ['bash', ['sh', 'shell', 'zsh', 'console', 'terminal']],
  ['python', ['py', 'py3', 'python3']],
  ['javascript', ['js', 'jsx', 'mjs', 'cjs', 'node']],
  ['typescript', ['ts', 'tsx', 'mts', 'cts']],
  ['json', ['jsonc', 'json5']],
  ['yaml', ['yml']],
  // xml 覆盖 html/svg/vue 模板：在 hljs 里本就是同一套语法
  ['xml', ['html', 'xhtml', 'svg', 'vue', 'rss', 'atom', 'plist', 'xsd', 'xsl']],
  ['css', []],
  ['markdown', ['md', 'mkd', 'mkdown']],
  ['diff', ['patch']],
  ['sql', []],
  ['go', ['golang']],
  ['rust', ['rs']],
  ['java', ['jsp']],
  ['c', ['h']],
  ['cpp', ['cc', 'c++', 'hpp', 'hh', 'cxx']],
  ['csharp', ['cs', 'c#']],
  ['lua', []],
  ['ini', ['toml']],
  ['dockerfile', ['docker']],
  ['powershell', ['ps', 'ps1']],
  ['makefile', ['make', 'mk']],
  ['http', ['https']],
  ['plaintext', ['plain', 'text', 'txt']],
  // 未纳入（体积/频次权衡）：scss 19KB、swift 23KB、php 15KB、ruby 10KB、kotlin 7KB。
  // 需要时往这里加一行再重跑即可。
];

/** 把一段 CJS 源码包成"取 module.exports"的表达式 */
function wrapModule(src) {
  return '(function(){var module={exports:{}};var exports=module.exports;\n'
    + src
    + '\nreturn module.exports;})()';
}

function build() {
  const core = fs.readFileSync(path.join(HLJS, 'lib', 'core.js'), 'utf8');
  if (/require\(/.test(core)) {
    throw new Error('hljs core 出现了 require()，本脚本的装配假设已失效，需改成真 bundler');
  }

  const parts = [];
  parts.push('var hljs=' + wrapModule(core) + ';');
  // 输入是 DOM textContent（已反转义），天然可能含 < & 等字符；不关这两个开关
  // hljs 会对合法代码刷警告甚至抛错。
  parts.push('hljs.configure({ignoreUnescapedHTML:true,throwUnescapedHTML:false});');

  for (const [name, aliases] of LANGS) {
    const file = path.join(HLJS, 'lib', 'languages', name + '.js');
    const src = fs.readFileSync(file, 'utf8');
    if (/require\(/.test(src)) {
      throw new Error(`语言 ${name} 出现了 require()，装配假设失效`);
    }
    parts.push(`hljs.registerLanguage(${JSON.stringify(name)},${wrapModule(src)});`);
    if (aliases.length) {
      parts.push(`hljs.registerAliases(${JSON.stringify(aliases)},{languageName:${JSON.stringify(name)}});`);
    }
  }

  parts.push('(typeof window!=="undefined"?window:globalThis).hljs=hljs;');

  const raw = '(function(){' + parts.join('\n') + '})();';
  return esbuild.transform(raw, {
    minify: true,
    target: ['chrome100', 'firefox100', 'safari15'],
    legalComments: 'none',
    format: 'iife',
  });
}

const outFile = path.join(__dirname, '..', 'src', 'webui', 'vendor', 'hljs.min.js');

build()
  .then((r) => {
    fs.writeFileSync(outFile, r.code, 'utf8');
    const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
    console.log(`✔ ${path.relative(process.cwd(), outFile)}  ${kb} KB  (${LANGS.length} 语言)`);
  })
  .catch((e) => {
    console.error('构建失败：', e && e.message);
    process.exit(1);
  });
