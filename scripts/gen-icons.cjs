#!/usr/bin/env node
/**
 * gen-icons — 把 lucide 全量包裁剪成「只含本项目用到的图标」的子集。
 *
 * 为什么要有这一步：
 *   vendor/lucide.min.js 是 397KB / 1939 个图标，而本项目实际只用了几十个。
 *   gzip 之后仍有 93KB，是首屏（除 app.js 外）最大的一笔，且 397KB 的 JS 解析
 *   也在主线程上。裁剪后通常只剩 15KB 左右。
 *
 * 为什么是「文本外科手术」而不是重新打包：
 *   本机的 esbuild 只能 transform 不能 build（Go 子进程读不到文件，见 gen-highlight.cjs），
 *   而用我自己的 createIcons 重写又会有「图标外观悄悄变样」的风险。
 *   这里的做法是**保留运行时一个字节都不动**，只删掉没用到的图标数据，因此
 *   DOM 输出与全量包逐字一致（脚本末尾会用真实执行来验证这一点）。
 *
 * 全量包的结构（lucide v1.8.0 UMD，压缩后）：
 *   ① 运行时 + 上千个 `const xxx=[[\"path\",{...}],...]`（图标数据，同一个声明语句里）
 *   ② `var Tu=Object.freeze({__proto__:null,AArrowDown:ru,...})`  ← 名字 → 标识符 的注册表
 *   ③ `a.AArrowDown=ru,` 逐条挂到 exports 上
 * 三处都要按同一份「保留集」收窄，否则要么图标缺失，要么残留死代码。
 *
 * 用法：
 *   node scripts/gen-icons.cjs           # 生成 vendor/lucide-subset.js
 *   node scripts/gen-icons.cjs --check   # 只校验（子集与源码是否同步），CI 用
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEBUI = path.join(ROOT, 'src', 'webui');
const FULL = path.join(WEBUI, 'vendor', 'lucide.min.js');
const OUT = path.join(WEBUI, 'vendor', 'lucide-subset.js');

/** 扫描图标名的来源文件（新增使用点时记得加进来） */
const SOURCES = ['index.html', 'app.js'];

/**
 * 兜底名单：这些名字没法从源码静态扫出来 —— 它们是**运行时拼进 data-lucide** 的
 * （PROVIDER_ICONS 映射表）。脚本会额外解析那段表；这里再留一份硬编码的，
 * 是为了「表被改名/挪位置」时也不会静默丢图标，宁可多留几个。
 *
 * `folder` / `file` / `file-code` 来自 pvIconFor()：它按扩展名 `return 'xxx'`，
 * 不是字面量 `data-lucide="xxx"`，所以上面的正则扫不到。漏掉的后果是文件树里
 * **目录行和代码文件行没有图标**（静默空白，肉眼看图才发现）。
 * icons.test.ts 里有一条守卫会盯住这三个名字。
 */
const RUNTIME_FALLBACK = ['bot', 'cloud', 'sparkles', 'wind', 'network', 'zap', 'cpu', 'box', 'hard-drive', 'folder', 'file', 'file-code'];

function die(msg) {
  console.error(`[gen-icons] ${msg}`);
  process.exit(1);
}

/** 在受控上下文里执行 UMD，拿到权威的图标数据（不做任何文本解析猜测） */
function loadLucide(src) {
  const sandbox = {};
  // UMD 依赖 this/globalThis 判定挂载点；没有 module/exports/define 时走浏览器分支
  // eslint-disable-next-line no-new-func
  new Function('globalThis', 'self', 'window', 'module', 'exports', 'define', src)(
    sandbox, sandbox, sandbox, undefined, undefined, undefined,
  );
  const L = sandbox.lucide;
  if (!L || !L.icons || typeof L.createIcons !== 'function') die('全量包没有导出 icons/createIcons');
  return L;
}

/** 收集源码里用到的图标名 */
function collectUsed() {
  const re = /data-lucide\s*=\s*(["'`])([a-z0-9-]+)\1/g;
  const used = new Map(); // name -> [file...]
  for (const file of SOURCES) {
    const src = fs.readFileSync(path.join(WEBUI, file), 'utf8');
    let m;
    let count = 0;
    while ((m = re.exec(src)) !== null) {
      const name = m[2];
      count++;
      if (!used.has(name)) used.set(name, []);
      if (!used.get(name).includes(file)) used.get(name).push(file);
    }
    if (count === 0) die(`${file} 里一个 data-lucide 都没扫到 —— 判据失效，拒绝生成空子集`);
  }

  // PROVIDER_ICONS：唯一一处「名字是变量」的地方
  const app = fs.readFileSync(path.join(WEBUI, 'app.js'), 'utf8');
  const block = /const PROVIDER_ICONS\s*=\s*\{([\s\S]*?)\}/.exec(app);
  if (block) {
    const valRe = /:\s*'([a-z0-9-]+)'/g;
    let m;
    while ((m = valRe.exec(block[1])) !== null) {
      if (!used.has(m[1])) used.set(m[1], ['app.js (PROVIDER_ICONS)']);
    }
  } else {
    console.warn('[gen-icons] 没找到 PROVIDER_ICONS，退回硬编码兜底名单');
  }
  for (const name of RUNTIME_FALLBACK) {
    if (!used.has(name)) used.set(name, ['硬编码兜底']);
  }
  return used;
}

/** 从 `起点` 开始做括号配平，返回闭合位置（含） */
function matchBracket(src, start) {
  const open = src[start];
  const close = { '[': ']', '{': '}', '(': ')' }[open];
  if (!close) die(`matchBracket 收到非括号字符 ${open}`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < src.length && src[i] !== ch) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  die('括号未配平 —— 全量包结构变了，脚本需要更新');
}

/**
 * 从声明语句里删掉 `<ident>=<值>` 这一段（连同前导逗号）。
 * 只用于「值一定是字面量」的图标声明，靠 matchBracket 保证不越界。
 */
function dropDeclarator(src, ident) {
  // 声明形如 `const a=[...],b=[...],c=[...];` —— 只认 `,ident=` 与 `const ident=`
  const patterns = [`,${ident}=`, `const ${ident}=`, `;${ident}=`];
  for (const pat of patterns) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(pat, from);
      if (at < 0) break;
      const valueStart = at + pat.length;
      const ch = src[valueStart];
      if (ch === '[' || ch === '{') {
        const end = matchBracket(src, valueStart);
        // 删掉「分隔符 + 标识符 + 值」。⚠️ 尾部那个逗号是**下一个**声明符的分隔符，
        // 必须保留 —— 曾经在这里 `tail.replace(/^,/, '')` 顺手把它吃掉，
        // 结果 `A=[...],B=[...]` 变成 `A=[...]C=[...]`，整包语法错误。
        const cutStart = pat.startsWith(',') ? at : at + 1;
        const head = src.slice(0, cutStart);
        const tail = src.slice(end + 1);
        // 删的是语句头（`const x=`）时，得把 `const ` 补给下一个声明符
        if (pat.startsWith('const')) return `const ${tail.replace(/^[,\s]*/, '')}`;
        return head + tail;
      }
      from = at + 1;
    }
  }
  return src; // 没找到（可能是别名共用同一个标识符）——不删，安全优先
}

/** kebab-case → PascalCase：`arrow-down` → `ArrowDown`、`check-circle-2` → `CheckCircle2`（与 lucide 的 toPascalCase 一致） */
function toPascal(name) {
  return String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function build() {
  const full = fs.readFileSync(FULL, 'utf8');
  const lib = loadLucide(full);
  const allNames = Object.keys(lib.icons); // PascalCase
  const used = collectUsed(); // kebab-case（源码里怎么写就怎么记）

  // 源码写 kebab，注册表是 Pascal ⇒ 统一成 Pascal 再比对
  const usedPascal = new Map(); // Pascal -> kebab
  const missing = [];
  for (const kebab of used.keys()) {
    const pascal = toPascal(kebab);
    if (!allNames.includes(pascal)) missing.push(`${kebab}(→${pascal})`);
    else usedPascal.set(pascal, kebab);
  }
  if (missing.length) die(`源码里用到但 lucide 没有这些图标：${missing.join(', ')}`);

  // ── ① 定位注册表：`var Tu=Object.freeze({__proto__:null,...})`
  const regAt = full.indexOf('=Object.freeze({');
  if (regAt < 0) die('找不到 Object.freeze({...}) 注册表 —— 全量包结构变了');
  const objStart = regAt + '=Object.freeze('.length;
  const objEnd = matchBracket(full, objStart);
  const regObj = full.slice(objStart + 1, objEnd); // 花括号内部
  if (!regObj.startsWith('__proto__:null,')) die('注册表没有以 __proto__:null 开头 —— 结构变了');

  const entries = regObj.slice('__proto__:null,'.length).split(',');
  const nameToIdent = new Map();
  for (const e of entries) {
    const m = /^([A-Z][A-Za-z0-9]*):([A-Za-z0-9_$]+)$/.exec(e);
    if (!m) die(`注册表条目无法解析：${JSON.stringify(e.slice(0, 60))}`);
    nameToIdent.set(m[1], m[2]);
  }
  if (nameToIdent.size !== allNames.length) {
    die(`注册表条目数(${nameToIdent.size}) 与运行时图标数(${allNames.length}) 不一致`);
  }

  // ── ② 计算保留集（同一标识符被多个名字共用时整体保留，否则会删掉还在用的数据）
  const keepNames = [...usedPascal.keys()].sort();
  const keepIdents = new Set(keepNames.map((n) => nameToIdent.get(n)));

  // ── ③ 收窄注册表
  const keepReg = keepNames.map((n) => `${n}:${nameToIdent.get(n)}`).join(',');
  let out = full.slice(0, objStart + 1) + '__proto__:null,' + keepReg + full.slice(objEnd);

  // ── ④ 删掉未使用图标的声明（按出现位置倒序删，避免位置错乱）
  const dropIdents = [...new Set([...nameToIdent.values()])].filter((id) => !keepIdents.has(id));
  const decls = [];
  for (const ident of dropIdents) {
    const at = full.indexOf(`,${ident}=`);
    if (at >= 0) decls.push({ ident, at });
  }
  decls.sort((a, b) => b.at - a.at);
  for (const { ident } of decls) out = dropDeclarator(out, ident);

  // ── ⑤ 删掉未使用的 exports 挂载 `a.Zap=au,`
  out = out.replace(/a\.([A-Z][A-Za-z0-9]*)=[A-Za-z0-9_$]+,/g, (m, name) =>
    (usedPascal.has(name) ? m : ''));

  // ── ⑥ 验证：重新执行，逐项比对数据与 DOM 无关的部分（图标节点数组）
  const patched = loadLucide(out);
  const patchedNames = Object.keys(patched.icons).sort();
  if (patchedNames.join(',') !== keepNames.join(',')) {
    const extra = patchedNames.filter((n) => !usedPascal.has(n));
    const gone = keepNames.filter((n) => !patchedNames.includes(n));
    die(`子集图标集合不符：多出 ${extra.slice(0, 5).join(',')}；缺失 ${gone.slice(0, 5).join(',')}`);
  }
  for (const name of keepNames) {
    if (JSON.stringify(patched.icons[name]) !== JSON.stringify(lib.icons[name])) {
      die(`图标 ${name} 的数据被改动了 —— 拒绝产出`);
    }
  }
  if (typeof patched.createIcons !== 'function') die('子集缺少 createIcons');

  const header = `/*! lucide v${(/\* @license lucide v([\d.]+)/.exec(full) || [])[1] || '?'} - ISC
 *  **本项目专用子集**：由 scripts/gen-icons.cjs 从 vendor/lucide.min.js 裁剪，
 *  只保留 ${keepNames.length} 个用到的图标（全量 ${allNames.length} 个）。
 *  运行时与官方包逐字节一致，仅删除了未使用的图标数据。
 *  ⚠️ 不要手改：新增图标请写在 index.html / app.js 的 data-lucide 上，
 *     然后跑 \`pnpm gen:icons\`（漏跑会让新图标静默消失，icons.test.ts 会拦）。
 */
`;
  return { css: header + out, keepNames, allNames };
}

const { css, keepNames, allNames } = build();

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== css) die('vendor/lucide-subset.js 与源码不同步：跑一次 node scripts/gen-icons.cjs');
  console.log(`[gen-icons] 已同步（${keepNames.length}/${allNames.length} 个图标）`);
} else {
  fs.writeFileSync(OUT, css, 'utf8');
  const kb = (n) => (n / 1024).toFixed(1);
  console.log(`[gen-icons] 写出 vendor/lucide-subset.js：${keepNames.length}/${allNames.length} 个图标，`
    + `${kb(fs.statSync(FULL).size)}KB → ${kb(Buffer.byteLength(css))}KB`);
}
