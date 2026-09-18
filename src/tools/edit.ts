import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';   // ← 内联副本使用同步 API（本文件其余部分用 async fs）
import path from 'node:path';   // ← 内联副本使用
import type { Tool } from './interface.js';
import { computeDiff } from '../utils/diff.js';
import { pushDiff } from './diff-channel.js';
import { getLastReadTime, getAnyReadTime, recordFileWrite } from './file-tracker.js';
import { refuseEditUnread } from './read-gate.js';
import { maybeRunDiagnostics } from './diagnostics.js';
import { detectEol, applyEol } from '../utils/eol.js';

/**
 * EditTool — 在文件中精确替换匹配的字符串 或 按行号替换
 *
 * 支持两种模式（互斥）：
 *
 * 模式一：字符串替换（原有逻辑）
 * - old_string (必需): 要被替换的字符串
 * - new_string (必需): 替换后的字符串
 * - replace_all (可选): 是否替换所有匹配，默认 false
 *
 * 模式二：行号替换（新增）
 * - line_start (必需): 替换起始行号 (1-based)
 * - line_count (可选): 替换行数，默认 1
 * - new_string (必需): 替换后的内容
 */
export class EditTool implements Tool {
  readonly name = 'edit';
  readonly sideEffect = 'write' as const;
  readonly description =
    '精确替换文件中的字符串，或按行号替换。字符串模式：old_string 必须唯一匹配（除非 replace_all=true）。行号模式：line_start 指定起始行（1-based），line_count 指定行数。两种模式互斥。';
  readonly companionDescription = '得改一下了。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The text to replace (must match exactly). Mutually exclusive with line_start.',
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences of old_string. Defaults to false.',
      },
      line_start: {
        type: 'number',
        description: 'Starting line number for replacement (1-based). Mutually exclusive with old_string.',
      },
      line_count: {
        type: 'number',
        description: 'Number of lines to replace. Defaults to 1.',
      },
    },
    required: ['file_path', 'new_string'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const newString = args.new_string as string;
    const lineStart = args.line_start as number | undefined;
    const oldString = args.old_string as string | undefined;

    if (!filePath) return '错误：缺少 file_path 参数。请提供文件的绝对路径。';
    if (newString === undefined || newString === null) return '错误：缺少 new_string 参数。请提供替换后的内容。';
    if (lineStart === undefined && oldString === undefined) return '错误：请提供 line_start（按行编辑）或 old_string（字符串替换）。';
    if (lineStart !== undefined && lineStart < 1) return '错误：line_start 必须 >= 1。';

    if (lineStart !== undefined && oldString !== undefined) {
      throw new Error(
        'line_start and old_string are mutually exclusive. Use one mode or the other.'
      );
    }

    // 拒绝编辑图片文件
    const IMG_SIGS = [
      [0xFF, 0xD8],                    // JPEG
      [0x89, 0x50, 0x4E, 0x47],       // PNG
      [0x47, 0x49, 0x46],             // GIF
      [0x42, 0x4D],                    // BMP
      [0x52, 0x49, 0x46, 0x46],       // WEBP (RIFF)
    ];
    try {
      const fh = await fs.open(filePath, 'r');
      const sniff = Buffer.alloc(12);
      await fh.read(sniff, 0, 12, 0);
      await fh.close();
      for (const sig of IMG_SIGS) {
        if (sig.every((b, i) => sniff[i] === b)) {
          return `Error: Cannot edit image files (${filePath}). Use specialized image tools instead.`;
        }
      }
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    // ── Read-before-write 门控 ──
    // 拒绝时不再只回一句错误，而是**交出 old_string 命中处的上下文**（教学 + 给料，3 轮压到 2 轮）。
    // edit 是锚定替换、改动只落在匹配处，故给出锚点上下文即可放行下一轮（边界见 read-gate.ts）；
    // 若 old_string 根本没命中，这个响应会直接告诉模型"你对这个文件内容的假设是错的"。
    // 门控强度随模式而变（见 read-gate.ts 的安全边界表）：
    //   - 字符串模式：old_string 可自校验（猜错就匹配不上 → 当场拒绝）→ 完整或部分读过都算；
    //   - 行模式（line_start，无锚点）：改动可落在**没看到过的行**上 → 与 write 同等严格，只认完整读过。
    const lastRead = oldString ? getAnyReadTime(filePath) : getLastReadTime(filePath);
    if (lastRead === null) {
      return refuseEditUnread(filePath, content, oldString, 'unread');
    }
    try {
      const stat = await fs.stat(filePath);
      // 注意：stat.mtimeMs 是高精度（带小数），Date.now() 是整数毫秒。
      // 同一毫秒内 read 后 edit 时，mtimeMs 小数部分会让它 > lastRead，误判为"外部修改"。
      // 加 50ms 容差吸收精度差异；真正的并发外部修改通常间隔更久。
      if (stat.mtimeMs > lastRead + 50) {
        return refuseEditUnread(filePath, content, oldString, 'stale');
      }
    } catch {}

    // TODO: 回收站机制 — edit 替换前把旧文件备份到 {sessionDir}/.recycle/{filename}.{timestamp}.bak
    //       当前 session 目录删除时（delete_session / cleanup 过期）回收站自动随 session 一起清掉，无需额外维护。
    //       需先解决 EditTool 获取 sessionDir 的问题（目前没有注入该信息）。

    let result: string;
    if (lineStart !== undefined) {
      result = await this.executeLineReplace(filePath, content, newString, lineStart, args);
    } else {
      result = await this.executeStringReplace(filePath, content, oldString!, newString, args);
    }

    // 记录写入
    recordFileWrite(filePath);

    // ── 自动诊断：修改后运行类型检查/编译检查 ──
    try {
      const diag = await maybeRunDiagnostics(process.cwd());
      if (diag) result += '\n\n' + diag;
    } catch { /* 诊断失败不影响工具返回值 */ }

    // ── 自动引用搜索：提取变更符号 → 项目内搜索引用 ──
    try {
      const effectiveOld = oldString ?? (() => {
        const ls = (args.line_start as number) ?? 1;
        const lc = (args.line_count as number) ?? 1;
        return content.split('\n').slice(ls - 1, ls - 1 + lc).join('\n');
      })();
      const ref = autoReferenceCheck(filePath, content, effectiveOld, newString);
      if (ref.text) result += '\n\n' + ref.text;
    } catch { /* 引用搜索失败不影响工具返回值 */ }

    return result;
  }

  private async executeLineReplace(
    filePath: string,
    content: string,
    newString: string,
    lineStart: number,
    args: Record<string, unknown>,
  ): Promise<string> {
    const lineCount = (args.line_count as number | undefined) ?? 1;
    const lines = content.split('\n');
    const start = lineStart - 1;

    if (start < 0 || start >= lines.length) {
      throw new Error(
        `line_start ${lineStart} is out of range. File has ${lines.length} lines.`
      );
    }

    if (lineCount < 1) {
      throw new Error('line_count must be at least 1.');
    }

    const end = Math.min(start + lineCount, lines.length);
    const before = lines.slice(0, start);
    const after = lines.slice(end);
    // 行模式的行尾处理（第一版想漏了，被字节级 E2E 抓出来）：
    // content 按 '\n' 切分后各行仍带 \r，join('\n') 恰好还原 CRLF —— 但**join 的分隔符本身
    // 也是 LF**，插入的 newString 里面的换行同样不会自动变 CRLF。只适配 newString 内部是不够的
    // （实测结果 "l1\r\nNEW1\r\nNEW2\nl3\r\n"，NEW2 后仍留裸 LF）。
    // 正确做法：拼完之后**整串按文件原有行尾统一规整一次**。applyEol 内部先 toLf 折平，
    // 因此不会把已有的 \r\n 变成 \r\r\n。
    const newContent = applyEol([...before, newString, ...after].join('\n'), detectEol(content));

    await fs.writeFile(filePath, newContent, 'utf-8');
    try { pushDiff(filePath, computeDiff(content, newContent, filePath)); } catch {}

    const replaced = end - start;
    // 生成变更摘要：显示替换后的内容
    const newLines = newString.split('\n');
    const previewLines = newLines.slice(0, 5);
    const preview = previewLines.join('\n');
    const truncated = newLines.length > 5;

    let result = `Successfully edited ${filePath} (replaced ${replaced} line${replaced > 1 ? 's' : ''} starting at line ${lineStart})`;
    result += `\n--- New content preview ---\n${preview}`;
    if (truncated) {
      result += `\n... (${newLines.length - 5} more lines)`;
    }
    result += `\n--- End preview ---`;
    return result;
  }

  private async executeStringReplace(
    filePath: string,
    content: string,
    oldString: string,
    newString: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const replaceAll = (args.replace_all as boolean | undefined) ?? false;

    // 行尾适配（2026-09-18 实测缺陷）：调用方给的 old/new_string 通常是 LF，
    // 而仓库既有文件是 CRLF。若不适配会有两个后果：
    //   ① 跨行 old_string 用 LF 去匹配 CRLF 文件**必然失败**（报 "not found"）；
    //   ② 写入的 new_string 会在 CRLF 文件里留下裸 LF，制造混合行尾
    //      （实测 src/tools/grep.ts 变成 CRLF=379 / 裸LF=22）。
    // 在分支之前统一把两侧适配成**文件原有行尾**，匹配与写回便自然一致。
    const eol = detectEol(content);
    oldString = applyEol(oldString, eol);
    newString = applyEol(newString, eol);

    const matchCount = this.countOccurrences(content, oldString);

    if (matchCount === 0) {
      throw new Error(
        `String not found in file: ${filePath}\n` +
        `The old_string was not found. Make sure the string matches exactly, including whitespace and indentation.`
      );
    }

    if (matchCount > 1 && !replaceAll) {
      throw new Error(
        `Multiple matches found (${matchCount} occurrences) in file: ${filePath}\n` +
        `Use replace_all=true to replace all occurrences, or provide a larger old_string that uniquely identifies the target.`
      );
    }

    let newContent: string;
    if (replaceAll) {
      newContent = content.split(oldString).join(newString);
    } else {
      const index = content.indexOf(oldString);
      newContent =
        content.slice(0, index) + newString + content.slice(index + oldString.length);
    }

    await fs.writeFile(filePath, newContent, 'utf-8');
    try { pushDiff(filePath, computeDiff(content, newContent, filePath)); } catch {}

    const replacementCount = replaceAll ? matchCount : 1;
    // 生成变更摘要：显示 old_string 和 new_string 的对比
    const oldPreview = oldString.split('\n').slice(0, 3).join('\n');
    const newPreview = newString.split('\n').slice(0, 3).join('\n');
    const oldTruncated = oldString.split('\n').length > 3;
    const newTruncated = newString.split('\n').length > 3;

    let result = `Successfully edited ${filePath} (${replacementCount} replacement${replacementCount > 1 ? 's' : ''})`;
    result += `\n--- Replaced ---\n${oldPreview}`;
    if (oldTruncated) result += '\n...';
    result += `\n--- With ---\n${newPreview}`;
    if (newTruncated) result += '\n...';
    result += '\n--- End diff ---';
    return result;
  }

  /**
   * 统计字符串在文本中出现的次数
   */
  private countOccurrences(text: string, search: string): number {
    if (search.length === 0) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(search, pos)) !== -1) {
      count++;
      pos += search.length;
    }
    return count;
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

