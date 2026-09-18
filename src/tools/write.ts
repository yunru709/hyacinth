import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';   // ← 内联副本使用同步 API（本文件其余部分用 async fs）
import path from 'node:path';
import type { Tool } from './interface.js';
import { computeDiff } from '../utils/diff.js';
import { pushDiff } from './diff-channel.js';
import { getLastReadTime, recordFileWrite } from './file-tracker.js';
import { refuseWriteUnread } from './read-gate.js';
import { maybeRunDiagnostics } from './diagnostics.js';
import { adaptEolTo } from '../utils/eol.js';

/**
 * WriteTool — 创建或覆盖文件
 *
 * 参数：
 * - file_path (必需): 文件的绝对路径
 * - content (必需): 要写入的文件内容
 *
 * 自动创建父目录（如果不存在），返回确认信息（文件路径和行数）
 */
export class WriteTool implements Tool {
  readonly name = 'write';
  readonly sideEffect = 'write' as const;
  readonly description =
    '创建或覆盖文件。自动创建不存在的父目录。写入后返回文件路径和行数。';
  readonly companionDescription = '写东西喽。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = (args.file_path || args.path) as string;
    const content = args.content as string;
    if (!filePath) {
      const received = Object.keys(args).filter(k => args[k] !== undefined && args[k] !== null);
      const rawJson = JSON.stringify(args);
      const truncated = rawJson.length > 500 ? rawJson.slice(0, 497) + '...' : rawJson;
      return `错误：缺少 file_path 参数。已收到参数: ${received.length > 0 ? received.join(', ') : '(无)'}。原始输入: ${truncated}。请使用 file_path 提供目标文件的绝对路径，例如 file_path: "/path/to/file.md"。`;
    }
    if (content === undefined || content === null) return '错误：缺少 content 参数。请提供要写入的内容。';

    // 自动创建父目录
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // ── Read-before-write 门控 ──
    let fileExists = false;
    try { await fs.access(filePath); fileExists = true; } catch {}
    if (fileExists) {
      const lastRead = getLastReadTime(filePath);
      if (lastRead === null) {
        // 拒绝覆盖，但**顺手把当前内容交出去**（教学 + 给料，3 轮压到 2 轮）。
        // 安全边界见 read-gate.ts 头部：「交出了多少，才允许往下走多少」——
        // 只有交出全文才算读过；只给片段时仍不放行（否则可能把没看到的中段写没）。
        let cur = '';
        try { cur = await fs.readFile(filePath, 'utf-8'); } catch {}
        return refuseWriteUnread(filePath, cur, 'unread');
      }
      try {
        const stat = await fs.stat(filePath);
        // 注意：stat.mtimeMs 是高精度（带小数），Date.now() 是整数毫秒。
        // 同一毫秒内 read 后 write 时，mtimeMs 小数部分会让它 > lastRead，误判为"外部修改"。
        // 加 50ms 容差吸收精度差异；真正的并发外部修改通常间隔更久。
        if (stat.mtimeMs > lastRead + 50) {
          // 这是**真实的安全信号**（文件被外部改过），不是流程形式 —— 同样把现状交出去
          let cur = '';
          try { cur = await fs.readFile(filePath, 'utf-8'); } catch {}
          return refuseWriteUnread(filePath, cur, 'stale');
        }
      } catch {}
    }

    // 读旧内容（如果文件存在）
    let oldContent = '';
    if (fileExists) {
      try { oldContent = await fs.readFile(filePath, 'utf-8'); } catch {}
    }

    // TODO: 回收站机制 — write 覆盖前把旧文件备份到 {sessionDir}/.recycle/{filename}.{timestamp}.bak
    //       当前 session 目录删除时（delete_session / cleanup 过期）回收站自动随 session 一起清掉，无需额外维护。
    //       需先解决 WriteTool 获取 sessionDir 的问题（目前没有注入该信息）。

    // 写入文件
    // PS 5.1 的 -File 靠 BOM 识别编码：无 BOM 的 UTF-8 脚本会被按 ANSI(GB2312) 解析，
    // 中文串乱码、甚至吞掉闭合引号导致解析期崩溃。脚本类后缀补 BOM。
    // 与 bash.ts 写临时 .ps1 的做法保持一致（那边注释已明确说明该坑）。
    const needsBom = /\.(ps1|psm1|bat|cmd)$/i.test(filePath);
    // 行尾纪律：**覆盖既有文件时适配该文件原有行尾**，避免整份翻成 LF。
    // 仓库既有文件是 CRLF（core.autocrlf=true），而模型给的 content 通常是 LF ——
    // 实测 background-registry.ts 就被这样从 CRLF 毁成纯 LF。新建文件保持 content 原样。
    const body = fileExists && oldContent ? adaptEolTo(content, oldContent) : content;
    await fs.writeFile(filePath, needsBom ? '\uFEFF' + body : body, 'utf-8');

    // 记录写入（写入后自动更新 readTime = writeTime）
    recordFileWrite(filePath);

    // 计算 diff
    try { pushDiff(filePath, computeDiff(oldContent, content, filePath)); } catch {}

    // 计算行数
    const lineCount = content.split('\n').length;

    // 生成内容摘要：前几行 + 总行数，让模型知道自己写了什么
    const lines = content.split('\n');
    const previewLines = lines.slice(0, 5);
    const preview = previewLines.join('\n');
    const truncated = lines.length > 5;

    let result = `Successfully wrote to ${filePath} (${lineCount} lines)`;
    result += `\n--- Content preview ---\n${preview}`;
    if (truncated) {
      result += `\n... (${lines.length - 5} more lines)`;
    }
    result += `\n--- End preview ---`;

    // ── 自动诊断：修改后运行类型检查/编译检查 ──
    try {
      const diag = await maybeRunDiagnostics(process.cwd());
      if (diag) result += '\n\n' + diag;
    } catch { /* 诊断失败不影响工具返回值 */ }

    // ── 自动引用搜索：覆盖已有文件时搜索变更符号的引用 ──
    if (oldContent) {
      try {
        const ref = autoReferenceCheck(filePath, oldContent, oldContent, content);
        if (ref.text) result += '\n\n' + ref.text;
      } catch { /* 引用搜索失败不影响工具返回值 */ }
    }

    return result;
  }
}

// ── [内联副本 begin]（与另一份逐字节一致，由守卫测试比对）────────────────
// ⚠️ 本段是**有意复制的副本**（方案 A）—— 它不是「工具之间零互相依赖」的例外，
//    而是该原则的执行方式：工具是动态的、会一个一个地变动，每个工具都应是独立个体；
//    抽公共模块**同样是耦合**（改它影响两个），故宁可重复。
//
// 同一段代码在 write.ts 与 edit.ts **各有一份，逐字节相同**。
// **改一处必须同时改另一处** —— 两份分叉会让 write 与 edit 对"引用"的理解产生分歧，
// 而这种 bug 两边单独看都正常、极难发现。守卫测试持续比对两份是否一致：
//   src/tools/inlined-copies-sync.test.ts
//
// 来源：原 src/tools/symbol-references.ts（2026-09-19 内联，原文件已删除）。
// 原文件头部的说明（为便于对照而保留在此）：
//   edit/write 工具执行成功后自动调用，提取变更涉及的符号名，在项目内搜索外部引用，
//   追加到工具返回值。探测项目根：被编辑文件向上找 .git → package.json → …；
//   符号提取：按后缀匹配语言，正则提取声明；未提取到时回溯最近的外层函数/类。
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
    if (fsSync.existsSync(path.join(current, '.git'))) {
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
      if (fsSync.existsSync(path.join(current, marker))) {
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
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
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
          const content = fsSync.readFileSync(fullPath, 'utf-8');
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

interface ReferenceResult {
  text: string; // 追加到工具返回值的文本，空字符串表示无结果
}

function autoReferenceCheck(
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

// ── [内联副本 end] ──────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────
// 仅测试用导出：特征化测试与守卫测试需要直接拿到内联副本的实现。
// **刻意放在上面的标记块之外** —— 否则 write.ts 与 edit.ts 两份块就不再逐字节一致，
// 守卫测试（inlined-copies-sync.test.ts）也就失去意义。
// 这不是给别的工具调用的 API：工具之间不得互相依赖（verify-layers 规则 6）。
// ─────────────────────────────────────────────────────────────────────
export { autoReferenceCheck as __autoReferenceCheckForTest };
