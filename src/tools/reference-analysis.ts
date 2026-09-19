/**
 * reference-analysis.ts —— 引用自检（核心模块；由 loop-tools 的后置序列消费）
 *
 * 来历：本段原为 src/tools/symbol-references.ts（2026-09-19 内联进 write.ts / edit.ts，
 * 成为**两份逐字节相同的副本** —— 即"方案 A"，当时理由是"抽公共模块同样是耦合，故宁可重复"）。
 * 现按《工具联动架构研究报告 v1.1》Phase 6 收敛为单一模块，**改判的两条理由**：
 *
 *   ① 兜底必须永远在。副本内联在核心工具里，若改造成"插件订阅"就随插件有无而消失；
 *      收敛成核心模块 + 由核心后置序列消费，则**与插件无关地始终生效**（行为无回退）。
 *   ② 子代理同样要覆盖。子代理跑同一套 stages，核心消费者自动覆盖它们；
 *      而插件钩子订阅形态会漏掉子代理（E2 已定性：子代理不接插件钩子）。
 *
 * 另：重复的代价原本由 inlined-copies-sync.test.ts 兜着 —— 一个测试的唯一职责就是"防两份分叉"，
 * 这本身就是"副本才是问题"的自证；该测试随本次收敛一并删除。
 *
 * **语义边界**：本模块是两份副本的**逐字搬移**（字符串扫描语义、上限、输出形态一字未改）。
 * 行为升级一律走上层的能力探针（loop-tools 后置序列：xref 挂载时用索引结果替代本模块输出），
 * 不改这里 —— 这样"无插件时行为与从前完全一致"是可验证的事实，而不是承诺。
 */
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/**
 * 找"项目根"——**带上溯边界**（2026-09-19 修）。
 *
 * 为什么要有边界：原实现会一路向上走到用户目录 ✗。而 `C:\Users\<name>\package.json`
 * 常常存在（某次 npm init 的残留即可），于是扫描根落到**用户目录** ✗ ⇒ 500 文件上限被
 * 系统目录吃光 ⇒ **连自己项目里的引用都扫不到**（实测：产出直接为空串）。
 *
 * 规则：
 *   · 向上走，但**不许越过 home 与盘根**；边界本身不作为项目根 ✓
 *   · 边界内找不到任何标记 ⇒ 退回**文件所在目录** ✓
 *   · 若连文件所在目录也在边界上（= 等于"扫描整个用户目录"）⇒ 返回 **null**，
 *     调用点**不扫描** —— 宁可"不说"，也不去翻用户目录 ✓
 *   · 主用例（仓库内改文件）不受影响：`.git` 在 home 之下，第一轮就命中 ✓
 */
function findProjectRoot(filePath: string): string | null {
  const dir = path.dirname(path.resolve(filePath));

  // 边界：home 与盘根（Windows 下大小写不敏感、尾部斜杠不敏感）
  const norm = (p: string): string => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const home = norm(os.homedir());
  const driveRoot = norm(path.parse(path.resolve(dir)).root);
  const atBoundary = (p: string): boolean => {
    const n = norm(p);
    return n === home || n === driveRoot;
  };

  /** 从 dir 向上找，命中任一标记即返回；到边界即停（边界本身不算项目根） */
  const walkUp = (markers: readonly string[]): string | null => {
    let current = dir;
    while (true) {
      if (atBoundary(current)) return null;
      for (const marker of markers) {
        if (fsSync.existsSync(path.join(current, marker))) return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  };

  // 先找 .git（严格优先），再找其他项目标记 —— 两轮都受同一边界约束
  const byGit = walkUp(['.git']);
  if (byGit) return byGit;
  const byMarker = walkUp(PROJECT_MARKERS);
  if (byMarker) return byMarker;

  // 都没找到：退回文件所在目录；若它本身就在边界上，则**不扫描**（见函数头说明）
  return atBoundary(dir) ? null : dir;
}

// ── 语言检测 ─────────────────────────────────────────────────

export function detectLang(filePath: string): LangConfig | null {
  const ext = path.extname(filePath).toLowerCase();
  return ALL_LANGUAGES[ext] ?? null;
}

// ── 符号提取 ─────────────────────────────────────────────────

export function extractSymbols(text: string, lang: LangConfig): string[] {
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

/**
 * 判定"这次改动涉及哪些符号" —— **兜底与能力共用这一份**。
 *
 * 两步（顺序即语义，不可省）：
 *   ① 从变更片段提取声明 —— write 传全文时即命中；
 *   ② 为空则退回"改动前内容里包住这段文本的声明" —— edit 传片段时的**常态**路径。
 *
 * 为什么必须是**一个函数**而不是"两处各自调用同样的工具"：Phase 6 第 2 步首版就是后者，
 * 能力侧漏掉了第①步之外的兜底 ⇒ 索引明明新鲜却返回空、白白退兜底（被能力测试当场抓住）。
 * 只要判定流程有两份实现，就一定有分叉的空间。
 */
export function resolveChangedSymbols(
  filePath: string,
  before: string,
  oldText: string,
  newText: string,
  max = 3,
): string[] {
  const lang = detectLang(filePath);
  if (!lang) return [];

  let symbols = extractSymbols(`${oldText}\n${newText}`, lang);
  if (symbols.length === 0) {
    const enclosing = findEnclosingSymbol(before, oldText, lang);
    if (enclosing) symbols = [enclosing];
  }
  return symbols.slice(0, max);
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
    // null = 边界内找不到可信的项目根（见 findProjectRoot 的说明）⇒ **不扫描**：
    // 与其翻遍用户目录、把 500 文件上限浪费在系统文件上，不如如实"没有结论"。
    const projectRoot = findProjectRoot(filePath);
    if (!projectRoot) return { text: '' };

    // 3. 符号判定（与能力侧共用同一函数 —— 见 resolveChangedSymbols 的说明）
    const symbols = resolveChangedSymbols(filePath, fileContent, oldString, newString);
    if (symbols.length === 0) return { text: '' };

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

/**
 * 能力探针契约：**xref 挂载时**注册它 —— 用索引给出精确结果（含 caller_name 与
 * [precise]/[heuristic] 标注）；未注册、返回空、或抛错时，消费者退回本模块的字符串扫描。
 *
 * 为什么"返回空也要退兜底"：能力方可能因为**索引陈旧**而给不出结论。
 * 此时若直接当"没有引用"，模型会得到**假阴性**；退兜底最多是回到从前的精度 —— 诚实优先。
 */
export interface ReferenceAnalysisCapability {
  analyze(input: ReferenceAnalysisInput): Promise<string | null> | string | null;
}

/** 归一化后的输入：各工具的差异（write 传全文、edit 传片段）在此抹平 */
export interface ReferenceAnalysisInput {
  /** 触发本次分析的写工具名（edit / write） */
  toolName: string;
  filePath: string;
  /** 改动前 / 后的**全文**（取自 diff 账本的结构事实） */
  before: string;
  after: string;
  /** 变更片段：edit 为 old/new 文本；write 为改动前后全文 */
  oldText: string;
  newText: string;
}

/** 取 before 的第 [lineStart, lineStart+lineCount) 行（与 edit 的 line_replace 口径一致） */
function sliceLines(text: string, lineStart: number, lineCount: number): string {
  return text.split('\n').slice(lineStart - 1, lineStart - 1 + lineCount).join('\n');
}

/**
 * 把工具入参 + 账本归一化成 ReferenceAnalysisInput —— **逐字对齐原调用点的语义**：
 *   write 原为 autoReferenceCheck(file, oldContent, oldContent, content) ⇒ 全文/全文/新全文
 *   edit  原为 autoReferenceCheck(file, content, effectiveOld, newString) ⇒ before/片段/新片段
 * （effectiveOld 的 line_replace 分支按 line_start/line_count 从改动前内容切片）
 */
export function normalizeReferenceInput(input: {
  toolName: string;
  filePath: string;
  before: string;
  after: string;
  args?: Record<string, unknown>;
}): ReferenceAnalysisInput {
  const { toolName, filePath, before, after, args = {} } = input;
  if (toolName === 'edit') {
    const oldString = typeof args.old_string === 'string' ? args.old_string : undefined;
    const effectiveOld =
      oldString ??
      sliceLines(
        before,
        typeof args.line_start === 'number' ? args.line_start : 1,
        typeof args.line_count === 'number' ? args.line_count : 1,
      );
    return { toolName, filePath, before, after, oldText: effectiveOld, newText: typeof args.new_string === 'string' ? args.new_string : after };
  }
  // write（及其它写工具）：全文前后
  return { toolName, filePath, before, after, oldText: before, newText: after };
}

/**
 * 消费者入口：**能力优先、兜底常在**。
 * 任一环节出问题都不得影响工具返回值 —— 与从前的 try/catch 语义一致。
 */
export async function analyzeReferences(
  capability: ReferenceAnalysisCapability | null | undefined,
  input: { toolName: string; filePath: string; before: string; after: string; args?: Record<string, unknown> },
): Promise<string> {
  const normalized = normalizeReferenceInput(input);
  if (capability) {
    try {
      const out = await capability.analyze(normalized);
      if (out) return out; // 能力给不出内容（如索引陈旧）→ 继续走兜底，不给假阴性
    } catch {
      // 能力失败 → 退兜底
    }
  }
  try {
    return autoReferenceCheck(normalized.filePath, normalized.before, normalized.oldText, normalized.newText).text;
  } catch {
    return '';
  }
}

// ── [内联副本 end] ──────────────────────────────────────────────────
