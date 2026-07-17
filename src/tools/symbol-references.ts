// ============================================================
// SymbolReferences — 编辑后自动引用搜索
// ============================================================
//
// edit/write 工具执行成功后自动调用，提取变更涉及的符号名，
// 在项目内搜索外部引用，追加到工具返回值。
//
// 探测项目根目录：被编辑文件向上找 .git → package.json → ... → 退出目录
// 符号提取：根据文件后缀匹配语言，正则提取声明（函数/类/变量/类型）
// 未提取到时 fallback：文件内向上回溯最近的外层函数/类
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

// ── 目录标记（按优先级）──────────────────────────────────────

const PROJECT_MARKERS = ['.git', 'package.json', 'tsconfig.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'Makefile', 'CMakeLists.txt'];

// ── 排除目录 ─────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', '__pycache__',
  '.venv', 'vendor', 'target', '.turbo', 'coverage', '.nyc_output',
  'cmake-build-',  // CMake build dirs (prefix match below)
]);

// ── 通用忽略关键字（所有语言共享）─────────────────────────────

const BASE_IGNORED = new Set([
  // 单字母 / 极短
  'i', 'j', 'k', 'x', 'y', 'z',
  // 通用编程关键字
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete',
  'true', 'false', 'null', 'undefined', 'nil', 'None', 'True', 'False',
  'import', 'from', 'as', 'async', 'await',
  'public', 'private', 'protected', 'static', 'readonly', 'abstract',
  'get', 'set', 'constructor', 'destructor',
  // 通用变量名
  'props', 'state', 'ref', 'args', 'result', 'data', 'value', 'error', 'err',
  'res', 'req', 'item', 'index', 'tmp', 'temp', 'ctx', 'obj', 'self', 'this',
  'super', 'other', 'key', 'val', 'msg', 'name', 'type', 'size', 'len',
]);

// ── 语言配置 ──────────────────────────────────────────────────

interface LangConfig {
  /** 搜索时扫描的文件后缀 */
  srcExts: Set<string>;
  /** 声明提取正则 */
  declPatterns: Array<{ pattern: RegExp; label: string }>;
  /** 该语言特有的排除关键字 */
  extraIgnored: Set<string>;
  /** 外层符号回溯时跳过的行前缀 */
  skipLinePrefixes: string[];
}

const ALL_LANGUAGES: Record<string, LangConfig> = {};

function defineLang(
  exts: string[],
  declPatterns: Array<{ pattern: RegExp; label: string }>,
  extraIgnored: string[],
  skipLinePrefixes: string[],
): void {
  const config: LangConfig = {
    srcExts: new Set(exts),
    declPatterns,
    extraIgnored: new Set(extraIgnored),
    skipLinePrefixes,
  };
  for (const ext of exts) {
    ALL_LANGUAGES[ext] = config;
  }
}

// ── TypeScript / JavaScript ───────────────────────────────────

defineLang(
  ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  [
    { pattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,  label: 'fn' },
    { pattern: /(?:export\s+)?class\s+(\w+)/g,                    label: 'class' },
    { pattern: /(?:export\s+)?interface\s+(\w+)/g,                label: 'interface' },
    { pattern: /(?:export\s+)?type\s+(\w+)\s*=/g,                label: 'type' },
    { pattern: /(?:export\s+)?enum\s+(\w+)/g,                     label: 'enum' },
    { pattern: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/g, label: 'var' },
  ],
  [
    'typeof', 'instanceof', 'void', 'default', 'export', 'yield',
    'implements', 'extends', 'declare', 'namespace', 'module', 'require',
    'keyof', 'infer', 'is', 'of', 'in',
    'console', 'log', 'warn', 'error', 'info', 'debug',
    'map', 'filter', 'reduce', 'forEach', 'push', 'pop', 'shift', 'unshift',
    'slice', 'splice', 'find', 'some', 'every', 'sort', 'reverse',
    'join', 'split', 'trim', 'replace', 'match',
  ],
  ['import', '//', '*'],
);

// ── Python ────────────────────────────────────────────────────

defineLang(
  ['.py', '.pyx', '.pxd'],
  [
    { pattern: /(?:async\s+)?def\s+(\w+)/g,  label: 'fn' },
    { pattern: /class\s+(\w+)/g,              label: 'class' },
    // 模块级变量赋值（顶格或 0-2 缩进，避免函数内部变量）
    { pattern: /^ {0,8}(\w+)\s*=\s*(?![=])/gm, label: 'var' },
  ],
  [
    'pass', 'yield', 'raise', 'with', 'except', 'lambda', 'global',
    'nonlocal', 'assert', 'del', 'print', 'open', 'range', 'enumerate',
    'zip', 'len', 'int', 'str', 'float', 'list', 'dict', 'set', 'tuple',
    'bool', 'type', 'object', 'isinstance', 'hasattr', 'getattr', 'setattr',
    'super', 'init', 'call', 'repr', 'iter', 'next',
    '__init__', '__str__', '__repr__', '__call__', '__getitem__', '__setitem__',
    '__len__', '__iter__', '__next__', '__enter__', '__exit__',
  ],
  ['import', 'from', '#', '"""', "'''"],
);

// ── Go ────────────────────────────────────────────────────────

defineLang(
  ['.go'],
  [
    { pattern: /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/g, label: 'fn' },
    { pattern: /type\s+(\w+)\s+(?:struct|interface)/g,  label: 'type' },
    { pattern: /var\s+(\w+)/g,                           label: 'var' },
    { pattern: /const\s+(\w+)/g,                         label: 'const' },
  ],
  [
    'func', 'type', 'var', 'const', 'package', 'import', 'go', 'defer',
    'chan', 'select', 'range', 'fallthrough', 'goto', 'interface', 'struct',
    'map', 'string', 'int', 'int8', 'int16', 'int32', 'int64',
    'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'complex64', 'complex128', 'bool', 'byte', 'rune',
    'error', 'make', 'append', 'copy', 'close', 'delete', 'panic', 'recover',
    'len', 'cap', 'fmt', 'Println', 'Printf', 'Sprintf', 'Errorf',
    'main', 'init',
  ],
  ['import', '//', '/*'],
);

// ── Rust ──────────────────────────────────────────────────────

defineLang(
  ['.rs'],
  [
    { pattern: /fn\s+(\w+)/g,                               label: 'fn' },
    { pattern: /struct\s+(\w+)/g,                            label: 'struct' },
    { pattern: /enum\s+(\w+)/g,                              label: 'enum' },
    { pattern: /trait\s+(\w+)/g,                             label: 'trait' },
    { pattern: /impl\s+(?:\w+\s+for\s+)?(\w+)/g,             label: 'impl' },
    { pattern: /type\s+(\w+)\s*=/g,                          label: 'type' },
    { pattern: /(?:pub\s+)?const\s+(\w+)/g,                  label: 'const' },
    { pattern: /(?:pub\s+)?static\s+(?:mut\s+)?(\w+)/g,      label: 'static' },
  ],
  [
    'fn', 'struct', 'enum', 'trait', 'impl', 'const', 'static', 'mut',
    'pub', 'crate', 'mod', 'use', 'where', 'dyn', 'ref', 'move',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'f32', 'f64', 'bool', 'char', 'str', 'String',
    'Vec', 'Option', 'Result', 'Some', 'None', 'Ok', 'Err',
    'Box', 'Rc', 'Arc', 'Cell', 'RefCell', 'Mutex',
    'self', 'Self', 'macro_rules', 'derive', 'clone', 'copy',
    'println', 'format', 'unwrap', 'expect', 'main',
  ],
  ['use', '//', '/*', '///', '//!'],
);

// ── C ─────────────────────────────────────────────────────────

defineLang(
  ['.c', '.h'],
  [
    // 函数声明/定义：返回类型 + 函数名
    { pattern: /(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*\{?/gm, label: 'fn' },
    // struct / enum / union 声明
    { pattern: /(?:typedef\s+)?struct\s+(\w+)/g,       label: 'struct' },
    { pattern: /(?:typedef\s+)?enum\s+(\w+)/g,          label: 'enum' },
    { pattern: /(?:typedef\s+)?union\s+(\w+)/g,          label: 'union' },
    // typedef
    { pattern: /typedef\s+(?:\w+\s+)+(\w+)\s*;/g,       label: 'typedef' },
    // #define 宏
    { pattern: /#define\s+(\w+)/g,                       label: 'define' },
  ],
  [
    'void', 'char', 'short', 'int', 'long', 'float', 'double',
    'signed', 'unsigned', 'const', 'volatile', 'register', 'extern',
    'sizeof', 'typedef', 'struct', 'enum', 'union',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'return', 'goto', 'default', 'NULL',
    'int8_t', 'int16_t', 'int32_t', 'int64_t',
    'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
    'size_t', 'ssize_t', 'ptrdiff_t', 'FILE',
    'printf', 'fprintf', 'sprintf', 'snprintf',
    'scanf', 'fscanf', 'sscanf',
    'malloc', 'calloc', 'realloc', 'free',
    'memcpy', 'memset', 'memmove', 'memcmp',
    'strcpy', 'strncpy', 'strlen', 'strcmp', 'strncmp',
    'open', 'close', 'read', 'write', 'main',
    'assert', 'exit',
  ],
  ['#include', '//', '/*'],
);

// ── 项目根目录探测 ───────────────────────────────────────────

function findProjectRoot(filePath: string): string {
  let dir = path.dirname(path.resolve(filePath));

  // 先找 .git
  let current = dir;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 没 .git 找其他项目标记
  current = dir;
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 什么都没有，退回文件所在目录
  return dir;
}

// ── 语言检测 ─────────────────────────────────────────────────

function detectLang(filePath: string): LangConfig | null {
  const ext = path.extname(filePath).toLowerCase();
  return ALL_LANGUAGES[ext] ?? null;
}

// ── 符号提取 ─────────────────────────────────────────────────

function extractSymbols(text: string, lang: LangConfig): string[] {
  const symbols = new Set<string>();
  const ignored = lang.extraIgnored;
  for (const { pattern } of lang.declPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      if (name.length >= 2 && !BASE_IGNORED.has(name) && !ignored.has(name)) {
        symbols.add(name);
      }
    }
  }
  return [...symbols];
}

// ── 外层符号回溯 ─────────────────────────────────────────────

function findEnclosingSymbol(
  fileContent: string,
  searchStr: string,
  lang: LangConfig,
): string | null {
  const idx = fileContent.indexOf(searchStr);
  if (idx === -1) return null;

  const before = fileContent.slice(0, idx).split('\n').reverse();
  const ignored = lang.extraIgnored;

  for (const line of before) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 跳过注释行和 import/use/include
    if (lang.skipLinePrefixes.some(p => trimmed.startsWith(p))) continue;

    for (const { pattern } of lang.declPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(trimmed);
      if (match) {
        const name = match[1];
        if (name.length >= 2 && !BASE_IGNORED.has(name) && !ignored.has(name)) {
          return name;
        }
      }
    }
  }

  return null;
}

// ── 引用扫描 ─────────────────────────────────────────────────

function scanReferences(
  projectRoot: string,
  symbols: string[],
  excludeFile: string,
  srcExts: Set<string>,
  maxFiles: number,
): Map<string, { files: string[]; total: number }> {
  const results = new Map<string, { files: string[]; total: number }>();
  const resolvedExclude = path.resolve(excludeFile);
  let scanned = 0;

  function walk(dir: string): void {
    if (scanned >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scanned >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        // CMake build dirs
        if (entry.name.startsWith('cmake-build-')) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!srcExts.has(ext)) continue;
        if (path.resolve(fullPath) === resolvedExclude) continue;
        scanned++;

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const sym of symbols) {
            if (content.includes(sym)) {
              let entry = results.get(sym);
              if (!entry) {
                entry = { files: [], total: 0 };
                results.set(sym, entry);
              }
              entry.total++;
              if (entry.files.length < 8) {
                entry.files.push(path.relative(projectRoot, fullPath));
              }
            }
          }
        } catch {
          // 读取失败跳过
        }
      }
    }
  }

  walk(projectRoot);
  return results;
}

// ── 公共入口 ─────────────────────────────────────────────────

export interface ReferenceResult {
  text: string; // 追加到工具返回值的文本，空字符串表示无结果
}

export function autoReferenceCheck(
  filePath: string,
  fileContent: string,
  oldString: string,
  newString: string,
): ReferenceResult {
  try {
    // 1. 检测语言
    const lang = detectLang(filePath);
    if (!lang) return { text: '' };

    // 2. 检测项目根目录
    const projectRoot = findProjectRoot(filePath);

    // 3. 提取符号：先从改动文本，再 fallback 外层符号
    const changedText = oldString + '\n' + newString;
    let symbols = extractSymbols(changedText, lang);

    if (symbols.length === 0) {
      const enclosing = findEnclosingSymbol(fileContent, oldString, lang);
      if (enclosing) symbols = [enclosing];
    }

    if (symbols.length === 0) return { text: '' };

    // 最多 3 个符号
    symbols = symbols.slice(0, 3);

    // 4. 扫描引用（只扫描同语言的文件）
    const refs = scanReferences(projectRoot, symbols, filePath, lang.srcExts, 500);

    if (refs.size === 0) return { text: '' };

    // 5. 格式化
    const lines: string[] = ['[References]'];
    for (const sym of symbols) {
      const entry = refs.get(sym);
      if (!entry || entry.total === 0) continue;

      const fileList = entry.files.join(', ');
      if (entry.total > entry.files.length) {
        lines.push(`  ${sym} → ${fileList}, ... (${entry.total} 个引用中还有 ${entry.total - entry.files.length} 个未列出，用 grep 查看全部)`);
      } else {
        lines.push(`  ${sym} → ${fileList}`);
      }
    }

    if (lines.length === 1) return { text: '' };
    return { text: lines.join('\n') };
  } catch {
    return { text: '' };
  }
}
