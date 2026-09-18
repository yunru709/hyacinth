/**
 * code-structure.ts — 轻量代码结构探测（纯函数，无 IO、无索引依赖）
 *
 * 为什么不用 xref：xref 需要先建索引、且索引会过期。而"这行命中属于哪个函数/类"
 * 这种问题用**纯文本回溯**就能答 90%，且永远新鲜、零依赖。所以本模块刻意做成
 * 无状态的：给文本，回结构。
 *
 * ⚠️ 已知重复（待合并，别假装没看见）：
 *   `src/tools/symbol-references.ts` 里有一份私有的语言配置与"回溯最近外层符号"
 *   逻辑（`LangConfig` / `defineLang` / `ALL_LANGUAGES` / `findEnclosingSymbol`）。
 *   正确终局是把那份下沉到这里、两边共用；但该文件**没有直接单测**，改动风险不划算，
 *   故先并存并在运行期验证。合并时请：把 symbol-references 的私有副本删掉，改为
 *   从本模块 import detectLang / extractSymbols / findEnclosingSymbol，并跑全量测试。
 *   （utils 不可反向 import tools —— 依赖方向会倒置，这是没直接复用的原因。）
 */

export type Lang = 'ts' | 'js' | 'py' | 'go' | 'rust' | 'java' | 'other';

export interface Decl {
  /** 声明名 */
  name: string;
  /** function / class / interface / type / enum / method / struct / impl / def */
  kind: string;
  /** 1-based 行号 */
  line: number;
}

/**
 * 控制流/保留字黑名单。
 * 不排掉它们，"方法"模式会把 `if (x) {` / `for (...) {` 当成方法定义 ——
 * E2E 实测就输出过 `↳ in method if (line 189)` 这种误导注记。
 * （与 symbol-references.ts 的 BASE_IGNORED 同类；终局应合并，见文件头 TODO。）
 */
const KEYWORD_BLOCK = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'do', 'try', 'catch', 'finally',
  'return', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'await', 'yield',
  'function', 'class', 'const', 'let', 'var', 'import', 'export', 'from', 'as',
  'break', 'continue', 'in', 'of', 'with', 'void', 'super', 'this',
]);

const EXT_LANG: Record<string, Lang> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyi: 'py',
  go: 'go',
  rs: 'rust',
  java: 'java',
};

export function detectLang(filePath: string): Lang {
  const ext = (filePath.split('.').pop() ?? '').toLowerCase();
  return EXT_LANG[ext] ?? 'other';
}

/** 各语言的声明模式：捕获组 1 = 名字，kind 为标签 */
function declPatterns(lang: Lang): Array<{ re: RegExp; kind: string; methodish?: boolean }> {
  const tsLike: Array<{ re: RegExp; kind: string; methodish?: boolean }> = [
    { re: /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /(?:^|\s)(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /(?:^|\s)(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
    { re: /(?:^|\s)(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type' },
    { re: /(?:^|\s)(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
    { re: /(?:^|\s)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function|\()/, kind: 'const-fn' },
    // 类方法：必须带 { 才认（否则会把调用当定义）
    {
      re: /^\s+(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^={;]*)?\{/,
      kind: 'method', methodish: true,
    },
  ];
  switch (lang) {
    case 'ts':
    case 'js':
      return tsLike;
    case 'py':
      return [
        { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'def' },
        { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
      ];
    case 'go':
      return [
        { re: /^\s*func\s+([A-Za-z_]\w*)/, kind: 'func' },
        { re: /^\s*func\s*\([^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method', methodish: true },
        { re: /^\s*type\s+([A-Za-z_]\w*)\s+struct/, kind: 'struct' },
        { re: /^\s*type\s+([A-Za-z_]\w*)\s+interface/, kind: 'interface' },
      ];
    case 'rust':
      return [
        { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'fn' },
        { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
        { re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
        { re: /^\s*impl(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)/, kind: 'impl' },
      ];
    case 'java':
      return [
        { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/, kind: 'class' },
        { re: /^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
        { re: /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>[\]]+\s+([A-Za-z_]\w*)\s*\(/, kind: 'method' },
      ];
    default:
      // 语言未知时给一个最通用的兜底，避免直接放弃
      return tsLike;
  }
}

/** 注释/装饰器行：回溯时不该把 `// foo()` 当成外层符号 */
function isNoise(trimmed: string): boolean {
  return !trimmed
    || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
    || trimmed.startsWith('#') || trimmed.startsWith('@') || trimmed.startsWith('///')
    || trimmed.startsWith('import') || trimmed.startsWith('use ')
    || trimmed.startsWith('from ');
}

/** 提取一段文本里的声明清单（name/kind/line），按行号升序 */
export function outline(text: string, lang?: Lang): Decl[] {
  const l = lang ?? 'other';
  const pats = declPatterns(l);
  const out: Decl[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isNoise(line.trim())) continue;
    for (const { re, kind } of pats) {
      const m = re.exec(line);
      if (m?.[1] && !KEYWORD_BLOCK.has(m[1])) { out.push({ name: m[1], kind, line: i + 1 }); break; }
    }
  }
  return out;
}

/**
 * 给一个 0-based 行号，回溯出它所属的最近声明。
 * @param lines 文件按行切分后的数组
 * @param lineIndex0 命中行的 0-based 下标
 */
export function findEnclosingDecl(lines: string[], lineIndex0: number, lang?: Lang): Decl | null {
  const l = lang ?? 'other';
  const pats = declPatterns(l);
  const from = Math.min(lineIndex0, lines.length - 1);
  for (let i = from; i >= 0; i--) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (isNoise(trimmed)) continue;
    for (const { re, kind } of pats) {
      const m = re.exec(line);
      if (m?.[1] && !KEYWORD_BLOCK.has(m[1])) return { name: m[1], kind, line: i + 1 };
    }
  }
  return null;
}

/**
 * 找某个声明的行区间（用于"按符号读"）。
 * C 系语言按花括号配平；Python 按缩进。找不到返回 null。
 */
export function findDeclRange(lines: string[], name: string, lang?: Lang): { start: number; end: number } | null {
  const l = lang ?? 'other';
  const pats = declPatterns(l);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isNoise(line.trim())) continue;
    for (const { re } of pats) {
      const m = re.exec(line);
      if (m?.[1] === name) { start = i; break; }
    }
    if (start !== -1) break;
  }
  if (start === -1) return null;

  if (l === 'py') {
    const indentOf = (s: string) => s.length - s.trimStart().length;
    const base = indentOf(lines[start]!);
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      const raw = lines[i]!;
      if (!raw.trim()) { end = i; continue; }
      if (indentOf(raw) <= base) break;
      end = i;
    }
    return { start: start + 1, end: end + 1 };
  }

  // C 系：从声明行起数花括号
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === '{') { depth++; seenBrace = true; }
      else if (ch === '}') depth--;
    }
    if (seenBrace && depth <= 0) return { start: start + 1, end: i + 1 };
  }
  // 没找到闭合（如 interface/type 这类无花括号或单行）→ 退化为声明行 + 若干行
  return { start: start + 1, end: Math.min(lines.length, start + 1) };
}
