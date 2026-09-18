/**
 * 交叉引用索引 — 类型定义与 SQLite Schema。
 *
 * 数据模型：
 *   files   → 已索引的源文件
 *   symbols → 符号定义（函数/类/接口/变量等）
 *   refs    → 符号引用（调用/实例化/读取/继承/导入）
 *   imports → 文件间导入依赖
 *   meta    → 元数据（构建时间、项目根目录等）
 */

// ── 数据类型 ──────────────────────────────────────────────────────────

export interface XrefSymbol {
  id: number;
  name: string;
  kind: SymbolKind;
  file_id: number;
  line: number;
  col: number;
  signature: string | null;
  is_exported: boolean;
  parent_name: string | null; // 方法的父类名
}

export interface XrefRef {
  id: number;
  symbol_name: string;
  file_id: number;
  line: number;
  col: number;
  kind: RefKind;
  context: string | null;
  caller_name: string | null; // 调用者函数名
}

export interface XrefImport {
  id: number;
  from_file_id: number;
  to_file_id: number;
  symbols: string[];
  import_type: ImportType;
}

export interface XrefFile {
  id: number;
  path: string;
  language: string;
  hash: string | null;
  last_parsed_at: string | null;
  /** 上次入库时的 mtime（毫秒）；同步构建据此判断是否需要重新解析 */
  mtime_ms: number | null;
}

// ── 枚举 ──────────────────────────────────────────────────────────────

export type SymbolKind =
  | 'function' | 'method' | 'arrow' | 'class' | 'interface'
  | 'type' | 'enum' | 'variable' | 'parameter' | 'property';

export type RefKind =
  | 'call' | 'new' | 'read' | 'write' | 'import' | 'inherit' | 'export';

/**
 * 导入边类型。
 *   static   — `import ... from` / 模块级 import
 *   dynamic  — `import('./x.js')`
 *   require  — CJS `require('./x')`
 *   reexport — `export * from` / `export { a } from`（桶文件透传，不是"使用"）
 *   include  — C/C++ `#include "x.h"`
 * 区分它们很重要：读 dependents 时要能看出上游是"真的用了"还是"只是转发"。
 */
export type ImportType = 'static' | 'dynamic' | 'require' | 'reexport' | 'include';

// ── 查询参数类型 ──────────────────────────────────────────────────────

export type QueryAction =
  | 'refs' | 'defs' | 'callers' | 'callees'
  | 'deps' | 'dependents' | 'hierarchy' | 'impact' | 'trace'
  | 'symbol_search';

export interface QueryParams {
  action: QueryAction;
  symbol?: string;
  file?: string;
  depth?: number;
  kind?: SymbolKind; // 过滤符号类型
  // 注：曾有 `format?: 'text' | 'json'`，但 query() 从未消费它（schema 空承诺），已移除
}

// ── 构建结果 ──────────────────────────────────────────────────────────

export interface BuildStats {
  files: number;
  symbols: number;
  refs: number;
  imports: number;
  duration_ms: number;
  language_breakdown: Record<string, number>;
  /** 本次构建模式：full=全部重新解析；sync=按 mtime 只解析变更文件 */
  mode?: 'full' | 'sync' | 'incremental';
  /** 本次实际解析的文件数（sync 下通常远小于 files） */
  parsed_files?: number;
  /** 磁盘上存在、但 mtime 未变而跳过的文件数（sync 模式） */
  unchanged_files?: number;
  /** 已从磁盘消失、本次被摘除索引的文件数 */
  removed_files?: number;
  /** 读取/解析失败被跳过的文件数（解析器异常不该静默吞掉） */
  failed_files?: number;
  /** 本应入图（项目内相对/模块内说明符）但解析失败的导入条数 */
  unresolved_imports?: number;
  /** 未解析导入样例（最多 10 条，形如 `a.ts → ./b.js`） */
  unresolved_samples?: string[];
  /** 解析成功但指向 npm 包等外部依赖的说明符条数（设计上不入图，不算缺失） */
  external_imports?: number;
}

// ── 解析器输出 ────────────────────────────────────────────────────────

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  col: number;
  signature?: string;
  is_exported: boolean;
  parent_name?: string; // 方法的父类
}

export interface ParsedRef {
  symbol_name: string;
  line: number;
  col: number;
  kind: RefKind;
  context?: string;
  caller_name?: string; // 谁发起的调用
}

export interface ParsedImport {
  to_path: string; // 被导入的文件路径
  symbols: string[];
  import_type: ImportType;
}

export interface ParsedFile {
  path: string;
  language: string;
  symbols: ParsedSymbol[];
  refs: ParsedRef[];
  imports: ParsedImport[];
  hash: string;
}

// ── Graph 输出 ────────────────────────────────────────────────────────

export type GraphFormat = 'text' | 'mermaid' | 'graphviz';

export interface GraphOptions {
  format: GraphFormat;
  symbol?: string;      // 以某个符号为中心
  file?: string;        // 以某个文件为中心
  max_depth?: number;   // 最大深度
  direction?: 'callers' | 'callees' | 'both';
}

// ── SQLite Schema DDL ─────────────────────────────────────────────────

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    language TEXT NOT NULL,
    hash TEXT,
    last_parsed_at TEXT,
    mtime_ms INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL DEFAULT 0,
    signature TEXT,
    is_exported INTEGER NOT NULL DEFAULT 0,
    parent_name TEXT
);

CREATE TABLE IF NOT EXISTS refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_name TEXT NOT NULL,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    context TEXT,
    caller_name TEXT
);

CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    to_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    symbols TEXT DEFAULT '[]',
    import_type TEXT DEFAULT 'static'
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- 查询加速
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON refs(symbol_name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_kind ON refs(kind);
CREATE INDEX IF NOT EXISTS idx_refs_caller ON refs(caller_name);
CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_to ON imports(to_file_id);
-- 复合索引：callees（按文件 + 调用者 + 类型）与「同名符号去重」是高频路径
CREATE INDEX IF NOT EXISTS idx_refs_file_caller_kind ON refs(file_id, caller_name, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind);
CREATE INDEX IF NOT EXISTS idx_imports_to_from ON imports(to_file_id, from_file_id);
`;

/**
 * 增量迁移：老库（v1）没有 mtime_ms 列。
 * CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，必须显式 ALTER。
 * 用 PRAGMA table_info 探测后再补，保证幂等。
 */
export const MIGRATION_ADD_MTIME = `ALTER TABLE files ADD COLUMN mtime_ms INTEGER`;
