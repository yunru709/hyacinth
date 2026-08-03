/**
 * XrefManager — 交叉引用索引管理器。
 *
 * 职责：
 *   - 管理 SQLite 数据库（创建、打开、关闭）
 *   - build(): 扫描项目、解析源码、存入索引
 *   - query(): 执行交叉引用查询
 *   - graph(): 生成可视化输出
 *   - 增量更新：只重新解析修改过的文件
 *
 * 数据库位置：~/.agent/cache/xref-<projectKey>.sqlite
 *
 * 上下文注册链路：
 *   manifest-defaults.ts → 无（工具通过 Tool API 提供，不进入上下文）
 *   工具注册：factory.ts → toolRegistry.register(new XrefBuildTool(manager))
 *   数据库：node:sqlite → ~/.agent/cache/xref-*.sqlite
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SCHEMA_DDL } from './schema.js';
import type {
  BuildStats, QueryParams, GraphOptions, GraphFormat,
  XrefSymbol, XrefRef, XrefImport, XrefFile, ParsedFile,
} from './schema.js';
import { ParserRegistry, createParserRegistry } from './parser.js';
import { toProjectKey } from '../../utils/misc.js';
import Database from '../sqlite.js';
import type { SqliteDatabase } from '../sqlite.js';

export class XrefManager {
  private db: SqliteDatabase | null = null;
  private dbPath: string = '';
  private parserRegistry: ParserRegistry | null = null;
  private rootDir: string = '';

  /** 初始化数据库（创建 if not exists，运行 schema DDL） */
  async init(rootDir: string): Promise<void> {
    this.rootDir = rootDir;
    const projectKey = toProjectKey(rootDir);
    const cacheDir = path.join(os.homedir(), '.agent', 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    this.dbPath = path.join(cacheDir, `xref-${projectKey}.sqlite`);

    this.db = Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_DDL);
  }

  /** 是否已初始化 */
  isReady(): boolean {
    return this.db !== null;
  }

  /** 获取索引统计信息 */
  getStats(): { files: number; symbols: number; refs: number; imports: number; built_at: string | null } | null {
    if (!this.db) return null;
    const files = this.db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
    const symbols = this.db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number };
    const refs = this.db.prepare('SELECT COUNT(*) as c FROM refs').get() as { c: number };
    const imports = this.db.prepare('SELECT COUNT(*) as c FROM imports').get() as { c: number };
    const meta = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('built_at') as { value: string } | undefined;
    return {
      files: files.c, symbols: symbols.c, refs: refs.c, imports: imports.c,
      built_at: meta?.value ?? null,
    };
  }

  // ── 构建索引 ────────────────────────────────────────────────────────

  /**
   * 构建/重建交叉引用索引。
   * @param changedFiles 可选：只重建这些文件（增量更新）。undefined = 全量重建。
   * @param dirs        可选：只扫描这些子目录（相对路径）。undefined = 全项目扫描。
   */
  async build(changedFiles?: string[], dirs?: string[], batchSize: number = 50): Promise<BuildStats> {
    if (!this.db) throw new Error('XrefManager not initialized. Call init() first.');

    const startedAt = Date.now();

    // 初始化 parser
    if (!this.parserRegistry) {
      this.parserRegistry = await createParserRegistry();
    }

    const isFullBuild = !changedFiles || changedFiles.length === 0;

    if (isFullBuild) {
      // 全量重建：清空所有数据
      this.db.exec('DELETE FROM refs');
      this.db.exec('DELETE FROM symbols');
      this.db.exec('DELETE FROM imports');
      this.db.exec('DELETE FROM files');
    }

    // 收集要解析的文件
    let filesToParse: string[];
    if (isFullBuild) {
      filesToParse = await this.scanFiles(this.rootDir, dirs);
    } else {
      // 增量：先删除旧数据
      const deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      for (const f of changedFiles) {
        deleteFile.run(f);
      }
      filesToParse = changedFiles.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return this.parserRegistry!.getParser(f) !== null;
      });
    }

    // 批量解析
    const insertFile = this.db.prepare(
      'INSERT OR REPLACE INTO files (path, language, hash, last_parsed_at) VALUES (?, ?, ?, ?)',
    );
    const insertSymbol = this.db.prepare(
      'INSERT INTO symbols (name, kind, file_id, line, col, signature, is_exported, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertRef = this.db.prepare(
      'INSERT INTO refs (symbol_name, file_id, line, col, kind, context, caller_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertImport = this.db.prepare(
      'INSERT INTO imports (from_file_id, to_file_id, symbols, import_type) VALUES (?, ?, ?, ?)',
    );

    let totalSymbols = 0;
    let totalRefs = 0;
    let totalImports = 0;
    const langBreakdown: Record<string, number> = {};

    // 分批解析（默认 50，可通过工具参数调整）
    const BATCH_SIZE = Math.max(1, Math.min(batchSize, 500));
    const allParsed: { file: string; data: ParsedFile }[] = [];

    for (let i = 0; i < filesToParse.length; i += BATCH_SIZE) {
      const batch = filesToParse.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (f) => {
          const parser = this.parserRegistry!.getParser(f);
          if (!parser) return null;
          try {
            return { file: f, data: await parser.parseFile(f) };
          } catch {
            return null;
          }
        }),
      );
      for (const r of batchResults) {
        if (r) allParsed.push(r);
      }
    }

    // 预解析所有导入路径（异步操作，不能放在事务中）
    const resolvedImports: Map<string, string | null> = new Map();
    for (const { file, data } of allParsed) {
      for (const imp of data.imports) {
        const key = `${file}::${imp.to_path}`;
        if (!resolvedImports.has(key)) {
          resolvedImports.set(key, await this.resolveImportPath(imp.to_path, file));
        }
      }
    }

    // 事务批量写入（同步操作）
    // eslint-disable-next-line @typescript-es/no-explicit-any
    const doBatch = this.db.transaction((parsedFiles: { file: string; data: ParsedFile }[]) => {
      for (const { file, data } of parsedFiles) {
        const now = new Date().toISOString();
        const result = insertFile.run(file, data.language, data.hash, now);
        const fileId = result.lastInsertRowid as number;

        langBreakdown[data.language] = (langBreakdown[data.language] ?? 0) + 1;

        for (const sym of data.symbols) {
          insertSymbol.run(sym.name, sym.kind, fileId, sym.line, sym.col, sym.signature ?? null, sym.is_exported ? 1 : 0, sym.parent_name ?? null);
          totalSymbols++;
        }

        for (const ref of data.refs) {
          insertRef.run(ref.symbol_name, fileId, ref.line, ref.col, ref.kind, ref.context ?? null, ref.caller_name ?? null);
          totalRefs++;
        }

        for (const imp of data.imports) {
          const key = `${file}::${imp.to_path}`;
          const resolved = resolvedImports.get(key);
          if (resolved) {
            // 查找或创建目标文件记录
            const toFile = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(resolved) as { id: number } | undefined;
            let toFileId: number;
            if (toFile) {
              toFileId = toFile.id;
            } else {
              const ext = path.extname(resolved).toLowerCase();
              const lang = this.guessLanguage(ext);
              const insResult = insertFile.run(resolved, lang, null, null);
              toFileId = insResult.lastInsertRowid as number;
            }
            insertImport.run(fileId, toFileId, JSON.stringify(imp.symbols), imp.import_type);
            totalImports++;
          }
        }
      }
    });

    doBatch(allParsed);

    // 更新 meta
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('built_at', new Date().toISOString());
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('root_dir', this.rootDir);

    const duration = Date.now() - startedAt;
    return {
      files: allParsed.length,
      symbols: totalSymbols,
      refs: totalRefs,
      imports: totalImports,
      duration_ms: duration,
      language_breakdown: langBreakdown,
    };
  }

  // ── 查询 ────────────────────────────────────────────────────────────

  /**
   * 执行交叉引用查询。
   */
  query(params: QueryParams): string {
    if (!this.db) return 'Error: Xref index not built. Run xref_build first.';

    const stats = this.getStats();
    if (!stats || stats.files === 0) {
      return 'Error: Xref index is empty. Run xref_build to build the index first.';
    }

    switch (params.action) {
      case 'refs':       return this.queryRefs(params);
      case 'defs':       return this.queryDefs(params);
      case 'callers':    return this.queryCallers(params);
      case 'callees':    return this.queryCallees(params);
      case 'deps':       return this.queryDeps(params);
      case 'dependents': return this.queryDependents(params);
      case 'hierarchy':  return this.queryHierarchy(params);
      case 'impact':     return this.queryImpact(params);
      case 'trace':        return this.queryTrace(params);
      case 'symbol_search': return this.querySymbolSearch(params);
      default:
        return `Unknown action: "${params.action}". Supported: refs, defs, callers, callees, deps, dependents, hierarchy, impact, trace, symbol_search`;
    }
  }

  private queryRefs(params: QueryParams): string {
    const { symbol } = params;
    if (!symbol) return 'Error: symbol is required for "refs" action.';

    const rows = this.db!.prepare(
      `SELECT r.*, f.path as file_path FROM refs r
       JOIN files f ON r.file_id = f.id
       WHERE r.symbol_name = ?
       ORDER BY f.path, r.line
       LIMIT 200`,
    ).all(symbol) as (XrefRef & { file_path: string })[];

    if (rows.length === 0) return `No references to "${symbol}" found.`;

    const lines: string[] = [];
    lines.push(`References to "${symbol}" (${rows.length} found):`);
    for (const r of rows) {
      const shortPath = this.toRelative(r.file_path);
      lines.push(`  ${shortPath}:${r.line} [${r.kind}]${r.context ? ` — ${r.context}` : ''}`);
    }
    if (rows.length === 200) lines.push('  ... (truncated at 200 results)');
    return lines.join('\n');
  }

  private queryDefs(params: QueryParams): string {
    const { symbol } = params;
    if (!symbol) return 'Error: symbol is required for "defs" action.';

    const rows = this.db!.prepare(
      `SELECT s.*, f.path as file_path FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.name = ?
       ORDER BY s.is_exported DESC, f.path`,
    ).all(symbol) as (XrefSymbol & { file_path: string; kind_filter?: string })[];

    if (rows.length === 0) return `No definition of "${symbol}" found.`;

    // 如果指定了 kind，过滤
    let filtered = rows;
    if (params.kind) {
      filtered = rows.filter(r => r.kind === params.kind);
    }

    const lines: string[] = [];
    lines.push(`Definition(s) of "${symbol}" (${filtered.length}):`);
    for (const s of filtered) {
      const shortPath = this.toRelative(s.file_path);
      const flags: string[] = [];
      if (s.is_exported) flags.push('exported');
      if (s.parent_name) flags.push(`in ${s.parent_name}`);
      const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';
      lines.push(`  [${s.kind}] ${shortPath}:${s.line}${flagStr}`);
      if (s.signature) lines.push(`    ${s.signature}`);
    }

    if (filtered.length > 1) {
      lines.push(`Tip: use "kind" parameter to filter by type (function, class, method, etc.)`);
    }
    return lines.join('\n');
  }

  private queryCallers(params: QueryParams): string {
    const { symbol } = params;
    if (!symbol) return 'Error: symbol is required for "callers" action.';

    // 查找所有调用该符号的位置（kind = 'call' or 'new'）
    const rows = this.db!.prepare(
      `SELECT r.*, f.path as file_path FROM refs r
       JOIN files f ON r.file_id = f.id
       WHERE r.symbol_name = ? AND r.kind IN ('call', 'new')
       ORDER BY f.path, r.line
       LIMIT 200`,
    ).all(symbol) as (XrefRef & { file_path: string })[];

    if (rows.length === 0) return `No callers of "${symbol}" found.`;

    const lines: string[] = [];
    lines.push(`Callers of "${symbol}" (${rows.length} found):`);
    for (const r of rows) {
      const shortPath = this.toRelative(r.file_path);
      const callerInfo = r.caller_name ? ` (in ${r.caller_name})` : '';
      lines.push(`  ${shortPath}:${r.line}${callerInfo}`);
      if (r.context) lines.push(`    ${r.context}`);
    }
    if (rows.length === 200) lines.push('  ... (truncated at 200 results)');
    return lines.join('\n');
  }

  private queryCallees(params: QueryParams): string {
    const { symbol, depth } = params;
    if (!symbol) return 'Error: symbol is required for "callees" action.';

    const maxDepth = depth ?? 1;
    const visited = new Set<string>();
    const output: string[] = [];
    output.push(`Callees of "${symbol}" (max depth: ${maxDepth}):`);

    this.traceCalleesRecursive(symbol, maxDepth, visited, output, 1);

    if (output.length === 1) {
      return `No callees found for "${symbol}". The function may have no calls or its body wasn't parsed.`;
    }
    return output.join('\n');
  }

  private traceCalleesRecursive(
    funcName: string, maxDepth: number, visited: Set<string>,
    output: string[], currentDepth: number,
  ): void {
    if (currentDepth > maxDepth || visited.has(funcName)) return;
    visited.add(funcName);

    // 查找该函数定义所在的文件
    const symRow = this.db!.prepare(
      `SELECT s.*, f.path as file_path FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.name = ? AND s.kind IN ('function', 'method', 'arrow')
       LIMIT 1`,
    ).get(funcName) as (XrefSymbol & { file_path: string }) | undefined;

    if (!symRow) return;

    // 查找该文件中以该函数为 caller_name 的 call refs
    const calleeRows = this.db!.prepare(
      `SELECT DISTINCT r.symbol_name FROM refs r
       WHERE r.file_id = ? AND r.caller_name = ? AND r.kind = 'call'
       LIMIT 50`,
    ).all(symRow.file_id, funcName) as { symbol_name: string }[];

    const indent = '  '.repeat(currentDepth);
    for (const callee of calleeRows) {
      if (visited.has(callee.symbol_name)) continue;
      output.push(`${indent}- ${callee.symbol_name}`);
      this.traceCalleesRecursive(callee.symbol_name, maxDepth, visited, output, currentDepth + 1);
    }
  }

  private queryDeps(params: QueryParams): string {
    const { file } = params;
    if (!file) return 'Error: file is required for "deps" action.';

    const resolved = this.resolvePath(file);
    const fileRow = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(resolved) as { id: number } | undefined;
    if (!fileRow) return `File not in index: ${file}`;

    const rows = this.db!.prepare(
      `SELECT i.*, f.path as to_path FROM imports i
       JOIN files f ON i.to_file_id = f.id
       WHERE i.from_file_id = ?
       ORDER BY f.path`,
    ).all(fileRow.id) as (XrefImport & { to_path: string })[];

    if (rows.length === 0) return `${this.toRelative(resolved)} has no tracked dependencies.`;

    const lines: string[] = [];
    lines.push(`${this.toRelative(resolved)} depends on (${rows.length}):`);
    for (const imp of rows) {
      const syms = imp.symbols.length > 0 ? ` {${imp.symbols.join(', ')}}` : '';
      lines.push(`  - ${this.toRelative(imp.to_path)}${syms}`);
    }
    return lines.join('\n');
  }

  private queryDependents(params: QueryParams): string {
    const { file } = params;
    if (!file) return 'Error: file is required for "dependents" action.';

    const resolved = this.resolvePath(file);
    const fileRow = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(resolved) as { id: number } | undefined;
    if (!fileRow) return `File not in index: ${file}`;

    const rows = this.db!.prepare(
      `SELECT i.*, f.path as from_path FROM imports i
       JOIN files f ON i.from_file_id = f.id
       WHERE i.to_file_id = ?
       ORDER BY f.path`,
    ).all(fileRow.id) as (XrefImport & { from_path: string })[];

    if (rows.length === 0) return `No files depend on ${this.toRelative(resolved)}.`;

    const lines: string[] = [];
    lines.push(`Files depending on ${this.toRelative(resolved)} (${rows.length}):`);
    for (const imp of rows) {
      const syms = imp.symbols.length > 0 ? ` {${imp.symbols.join(', ')}}` : '';
      lines.push(`  - ${this.toRelative(imp.from_path)}${syms}`);
    }
    return lines.join('\n');
  }

  private queryHierarchy(params: QueryParams): string {
    const { symbol } = params;
    if (!symbol) return 'Error: symbol is required for "hierarchy" action.';

    // 查找类的继承关系
    const classRow = this.db!.prepare(
      `SELECT s.*, f.path as file_path FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.name = ? AND s.kind = 'class'
       LIMIT 1`,
    ).get(symbol) as (XrefSymbol & { file_path: string }) | undefined;

    if (!classRow) return `Class "${symbol}" not found in index.`;

    // 查找父类（通过 inherit refs）
    const parentRefs = this.db!.prepare(
      `SELECT r.symbol_name FROM refs r
       WHERE r.file_id = ? AND r.kind = 'inherit' AND r.caller_name = ?
       ORDER BY r.line`,
    ).all(classRow.file_id, symbol) as { symbol_name: string }[];

    // 查找子类（通过 inherit refs 引用了该 symbol）
    const childRefs = this.db!.prepare(
      `SELECT r.caller_name as child_name, f.path as file_path, r.line FROM refs r
       JOIN files f ON r.file_id = f.id
       WHERE r.symbol_name = ? AND r.kind = 'inherit'
       ORDER BY f.path`,
    ).all(symbol) as { child_name: string; file_path: string; line: number }[];

    const lines: string[] = [];
    lines.push(`Hierarchy for class "${symbol}" (${this.toRelative(classRow.file_path)}:${classRow.line}):`);

    if (parentRefs.length > 0) {
      lines.push(`  Parents:`);
      for (const p of parentRefs) {
        lines.push(`    - ${p.symbol_name}`);
      }
    } else {
      lines.push(`  Parents: (none — root class)`);
    }

    if (childRefs.length > 0) {
      lines.push(`  Children (${childRefs.length}):`);
      for (const c of childRefs) {
        lines.push(`    - ${c.child_name} (${this.toRelative(c.file_path)}:${c.line})`);
      }
    } else {
      lines.push(`  Children: (none)`);
    }

    return lines.join('\n');
  }

  private queryImpact(params: QueryParams): string {
    const { file, symbol, depth } = params;
    if (!file) return 'Error: file is required for "impact" action.';

    const resolved = this.resolvePath(file);
    const maxDepth = depth ?? 2;

    // BFS: 查找依赖该文件的所有文件
    const visited = new Set<string>();
    const queue: { path: string; depth: number }[] = [{ path: resolved, depth: 0 }];
    visited.add(resolved);

    const layers: Map<number, string[]> = new Map();

    while (queue.length > 0) {
      const { path: current, depth: d } = queue.shift()!;
      if (d >= maxDepth) continue;

      const fileRow = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(current) as { id: number } | undefined;
      if (!fileRow) continue;

      // 查找导入 current 的文件
      const dependents = this.db!.prepare(
        `SELECT DISTINCT f.path as from_path FROM imports i
         JOIN files f ON i.from_file_id = f.id
         WHERE i.to_file_id = ?
         ORDER BY f.path`,
      ).all(fileRow.id) as { from_path: string }[];

      for (const dep of dependents) {
        if (visited.has(dep.from_path)) continue;
        visited.add(dep.from_path);

        const nextDepth = d + 1;
        const layer = layers.get(nextDepth) ?? [];
        layer.push(dep.from_path);
        layers.set(nextDepth, layer);

        queue.push({ path: dep.from_path, depth: nextDepth });
      }
    }

    if (layers.size === 0) {
      const symSuffix = symbol ? ` (symbol: ${symbol})` : '';
      return `No files are affected by changing ${this.toRelative(resolved)}${symSuffix}.`;
    }

    const lines: string[] = [];
    const symSuffix = symbol ? ` (symbol: ${symbol})` : '';
    lines.push(`Impact of changing ${this.toRelative(resolved)}${symSuffix} (max depth: ${maxDepth}):`);

    const sortedDepths = [...layers.keys()].sort((a, b) => a - b);
    let total = 0;
    for (const d of sortedDepths) {
      const files = layers.get(d)!;
      total += files.length;
      lines.push(`  Layer ${d} (${files.length} files):`);
      for (const f of files) {
        lines.push(`    - ${this.toRelative(f)}`);
      }
    }
    lines.push(`  Total: ${total} files across ${layers.size} layers`);

    return lines.join('\n');
  }

  private queryTrace(params: QueryParams): string {
    const { symbol, file } = params;
    if (!symbol) return 'Error: symbol is required for "trace" action.';
    if (!file) return 'Error: file is required for "trace" action.';

    const resolved = this.resolvePath(file);
    const fileRow = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(resolved) as { id: number } | undefined;
    if (!fileRow) return `File not in index: ${file}`;

    // 查找该变量在该文件中的所有引用
    const rows = this.db!.prepare(
      `SELECT * FROM refs
       WHERE symbol_name = ? AND file_id = ?
       ORDER BY line`,
    ).all(symbol, fileRow.id) as XrefRef[];

    if (rows.length === 0) return `No references to "${symbol}" found in ${this.toRelative(resolved)}.`;

    const lines: string[] = [];
    lines.push(`Data flow for "${symbol}" in ${this.toRelative(resolved)} (${rows.length} points):`);

    // 按 kind 分组
    const kindOrder: Record<string, number> = {
      'write': 0, 'export': 1, 'call': 2, 'new': 3, 'read': 4, 'import': 5, 'inherit': 6,
    };

    const sorted = [...rows].sort((a, b) => {
      const ka = kindOrder[a.kind] ?? 99;
      const kb = kindOrder[b.kind] ?? 99;
      if (ka !== kb) return ka - kb;
      return a.line - b.line;
    });

    let currentKind = '';
    for (const r of sorted) {
      if (r.kind !== currentKind) {
        currentKind = r.kind;
        const kindCount = sorted.filter(rr => rr.kind === currentKind).length;
        lines.push(`  ${currentKind} (${kindCount}):`);
      }
      lines.push(`    L${r.line}${r.context ? `: ${r.context}` : ''}`);
    }

    return lines.join('\n');
  }

  private querySymbolSearch(params: QueryParams): string {
    const { symbol } = params;
    if (!symbol) return 'Error: symbol is required for "symbol_search" action.';

    // 查找哪些文件通过 import 引入了该符号
    const rows = this.db!.prepare(
      `SELECT i.*, f1.path as from_path, f2.path as to_path FROM imports i
       JOIN files f1 ON i.from_file_id = f1.id
       JOIN files f2 ON i.to_file_id = f2.id
       WHERE i.symbols LIKE ?
       ORDER BY f1.path
       LIMIT 200`,
    ).all(`%${symbol}%`) as (XrefImport & { from_path: string; to_path: string })[];

    // 过滤：精确匹配符号名
    const matched = rows.filter(r => {
      try {
        const syms: string[] = typeof r.symbols === 'string' ? JSON.parse(r.symbols) : r.symbols;
        return syms.includes(symbol);
      } catch {
        return false;
      }
    });

    if (matched.length === 0) return `No files import symbol "${symbol}".`;

    const lines: string[] = [];
    lines.push(`Files importing "${symbol}" (${matched.length}):`);

    // 去重
    const seen = new Set<string>();
    for (const imp of matched) {
      const key = `${imp.from_path}→${imp.to_path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${this.toRelative(imp.from_path)} → ${this.toRelative(imp.to_path)} [${imp.import_type}]`);
    }

    return lines.join('\n');
  }

  // ── 可视化 ──────────────────────────────────────────────────────────

  /**
   * 生成调用图/依赖图可视化。
   */
  graph(options: GraphOptions): string {
    if (!this.db) return 'Error: Xref index not built. Run xref_build first.';

    const format = options.format ?? 'mermaid';
    const maxDepth = options.max_depth ?? 3;

    switch (format) {
      case 'mermaid':  return this.graphMermaid(options, maxDepth);
      case 'text':     return this.graphText(options, maxDepth);
      case 'graphviz': return this.graphGraphviz(options, maxDepth);
      default:         return `Unknown format: ${format}. Supported: text, mermaid, graphviz`;
    }
  }

  private graphMermaid(options: GraphOptions, maxDepth: number): string {
    const { symbol, file, direction } = options;
    const dir = direction ?? 'both';

    const lines: string[] = [];
    lines.push('```mermaid');
    lines.push('graph LR');

    const visited = new Set<string>();
    const edges: [string, string, string][] = []; // [from, to, label]

    if (symbol) {
      // 以符号为中心的调用图
      if (dir === 'callers' || dir === 'both') {
        this.collectCallerEdges(symbol, maxDepth, visited, edges, 'calls');
      }
      if (dir === 'callees' || dir === 'both') {
        this.collectCalleeEdges(symbol, maxDepth, visited, edges, 'calls');
      }
    }

    if (file) {
      // 以文件为中心的依赖图
      this.collectFileDepsEdges(file, maxDepth, visited, edges);
    }

    if (edges.length === 0) {
      lines.push('    empty[No relationships found]');
    } else {
      const nodeIds = new Set<string>();
      for (const [from, to] of edges) {
        nodeIds.add(from);
        nodeIds.add(to);
      }
      for (const id of nodeIds) {
        const escaped = id.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(`    ${escaped}[${this.shorten(id)}]`);
      }
      for (const [from, to, label] of edges) {
        const fEsc = from.replace(/[^a-zA-Z0-9_]/g, '_');
        const tEsc = to.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(`    ${fEsc} -->|${label}| ${tEsc}`);
      }
    }

    lines.push('```');
    return lines.join('\n');
  }

  private graphText(options: GraphOptions, maxDepth: number): string {
    const { symbol, file, direction } = options;
    const dir = direction ?? 'both';
    const visited = new Set<string>();
    const lines: string[] = [];

    if (symbol) {
      lines.push(`Call graph for "${symbol}" (max depth: ${maxDepth}):`);
      if (dir === 'callers' || dir === 'both') {
        lines.push('  ▲ Callers (who calls this):');
        this.textTreeCallers(symbol, '', visited, maxDepth, 0, lines);
      }
      if (dir === 'callees' || dir === 'both') {
        lines.push('  ▼ Callees (this calls):');
        this.textTreeCallees(symbol, '', new Set(), maxDepth, 0, lines);
      }
    }

    if (file) {
      const resolved = this.resolvePath(file);
      lines.push(`Dependency graph for ${this.toRelative(resolved)} (max depth: ${maxDepth}):`);
      this.textTreeFileDeps(resolved, '', new Set(), maxDepth, 0, lines);
    }

    return lines.join('\n');
  }

  private textTreeCallers(symbol: string, prefix: string, visited: Set<string>, maxDepth: number, depth: number, output: string[]): void {
    if (depth >= maxDepth || visited.has(symbol)) return;
    visited.add(symbol);

    const callers = this.db!.prepare(
      `SELECT DISTINCT r.caller_name FROM refs r
       WHERE r.symbol_name = ? AND r.kind IN ('call', 'new') AND r.caller_name IS NOT NULL
       LIMIT 30`,
    ).all(symbol) as { caller_name: string }[];

    for (let i = 0; i < callers.length; i++) {
      const c = callers[i];
      const isLast = i === callers.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      output.push(`${prefix}${connector}${c.caller_name}`);
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      this.textTreeCallers(c.caller_name, nextPrefix, visited, maxDepth, depth + 1, output);
    }
  }

  private textTreeCallees(symbol: string, prefix: string, visited: Set<string>, maxDepth: number, depth: number, output: string[]): void {
    if (depth >= maxDepth || visited.has(symbol)) return;
    visited.add(symbol);

    const symRow = this.db!.prepare(
      `SELECT s.id, s.file_id FROM symbols s WHERE s.name = ? AND s.kind IN ('function', 'method', 'arrow') LIMIT 1`,
    ).get(symbol) as { id: number; file_id: number } | undefined;
    if (!symRow) return;

    const callees = this.db!.prepare(
      `SELECT DISTINCT r.symbol_name FROM refs r
       WHERE r.file_id = ? AND r.caller_name = ? AND r.kind = 'call'
       LIMIT 30`,
    ).all(symRow.file_id, symbol) as { symbol_name: string }[];

    for (let i = 0; i < callees.length; i++) {
      const c = callees[i];
      const isLast = i === callees.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      output.push(`${prefix}${connector}${c.symbol_name}`);
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      this.textTreeCallees(c.symbol_name, nextPrefix, visited, maxDepth, depth + 1, output);
    }
  }

  private textTreeFileDeps(filePath: string, prefix: string, visited: Set<string>, maxDepth: number, depth: number, output: string[]): void {
    if (depth >= maxDepth || visited.has(filePath)) return;
    visited.add(filePath);

    const fileRow = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
    if (!fileRow) return;

    const deps = this.db!.prepare(
      `SELECT DISTINCT f.path FROM imports i
       JOIN files f ON i.from_file_id = f.id
       WHERE i.to_file_id = ?
       LIMIT 30`,
    ).all(fileRow.id) as { path: string }[];

    for (let i = 0; i < deps.length; i++) {
      const d = deps[i];
      const isLast = i === deps.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      output.push(`${prefix}${connector}${this.toRelative(d.path)}`);
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      this.textTreeFileDeps(d.path, nextPrefix, visited, maxDepth, depth + 1, output);
    }
  }

  private graphGraphviz(options: GraphOptions, maxDepth: number): string {
    const { symbol } = options;
    const lines: string[] = [];
    lines.push('```dot');
    lines.push('digraph G {');
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box, style=rounded];');

    const visited = new Set<string>();
    const edges: [string, string, string][] = [];

    if (symbol) {
      this.collectCallerEdges(symbol, maxDepth, visited, edges, 'calls');
      this.collectCalleeEdges(symbol, maxDepth, visited, edges, 'calls');
    }

    if (edges.length === 0) {
      lines.push('  empty [label="No relationships found"];');
    } else {
      const nodeIds = new Set<string>();
      for (const [from, to] of edges) { nodeIds.add(from); nodeIds.add(to); }
      for (const id of nodeIds) {
        lines.push(`  "${id}" [label="${this.shorten(id)}"];`);
      }
      for (const [from, to, label] of edges) {
        lines.push(`  "${from}" -> "${to}" [label="${label}"];`);
      }
    }

    lines.push('}');
    lines.push('```');
    return lines.join('\n');
  }

  // ── 图遍历辅助 ──────────────────────────────────────────────────────

  private collectCallerEdges(symbol: string, maxDepth: number, visited: Set<string>, edges: [string, string, string][], label: string, depth: number = 0): void {
    if (depth >= maxDepth || visited.has(symbol)) return;
    visited.add(symbol);

    const callers = this.db!.prepare(
      `SELECT DISTINCT r.caller_name FROM refs r
       WHERE r.symbol_name = ? AND r.kind IN ('call', 'new') AND r.caller_name IS NOT NULL
       LIMIT 30`,
    ).all(symbol) as { caller_name: string }[];

    for (const c of callers) {
      edges.push([c.caller_name, symbol, label]);
      this.collectCallerEdges(c.caller_name, maxDepth, visited, edges, label, depth + 1);
    }
  }

  private collectCalleeEdges(symbol: string, maxDepth: number, visited: Set<string>, edges: [string, string, string][], label: string, depth: number = 0): void {
    if (depth >= maxDepth || visited.has(symbol)) return;
    visited.add(symbol);

    const symRow = this.db!.prepare(
      `SELECT s.id, s.file_id FROM symbols s WHERE s.name = ? AND s.kind IN ('function', 'method', 'arrow') LIMIT 1`,
    ).get(symbol) as { id: number; file_id: number } | undefined;
    if (!symRow) return;

    const callees = this.db!.prepare(
      `SELECT DISTINCT r.symbol_name FROM refs r
       WHERE r.file_id = ? AND r.caller_name = ? AND r.kind = 'call'
       LIMIT 30`,
    ).all(symRow.file_id, symbol) as { symbol_name: string }[];

    for (const c of callees) {
      edges.push([symbol, c.symbol_name, label]);
      this.collectCalleeEdges(c.symbol_name, maxDepth, visited, edges, label, depth + 1);
    }
  }

  private collectFileDepsEdges(file: string, maxDepth: number, visited: Set<string>, edges: [string, string, string][]): void {
    const resolved = this.resolvePath(file);
    const queue: { path: string; depth: number }[] = [{ path: resolved, depth: 0 }];
    visited.add(resolved);

    while (queue.length > 0) {
      const { path: current, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const fileRow = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(current) as { id: number } | undefined;
      if (!fileRow) continue;

      const deps = this.db!.prepare(
        `SELECT DISTINCT f.path FROM imports i
         JOIN files f ON i.from_file_id = f.id
         WHERE i.to_file_id = ?
         LIMIT 30`,
      ).all(fileRow.id) as { path: string }[];

      for (const dep of deps) {
        edges.push([this.toRelative(dep.path), this.toRelative(current), 'imports']);
        if (!visited.has(dep.path)) {
          visited.add(dep.path);
          queue.push({ path: dep.path, depth: depth + 1 });
        }
      }
    }
  }

  // ── 文件扫描 ────────────────────────────────────────────────────────

  /**
   * 扫描项目目录，收集需要解析的源文件。
   * @param dirs 可选：只扫描这些子目录（相对路径）。undefined = 全项目扫描。
   */
  private async scanFiles(rootDir: string, dirs?: string[]): Promise<string[]> {
    const exts = this.parserRegistry?.getAllExtensions() ?? ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
    const extSet = new Set(exts);
    const files: string[] = [];

    const scanDir = async (d: string): Promise<void> => {
      try {
        const entries = await fs.readdir(d, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            if (['node_modules', 'dist', '.git', 'coverage', '.next', 'build', 'target', '__pycache__', '.venv', 'venv', '.agent'].includes(entry.name)) continue;
            if (entry.name.startsWith('.')) continue;
            await scanDir(fullPath);
          } else if (extSet.has(path.extname(entry.name).toLowerCase())) {
            // 跳过 .d.ts 和 .min.js
            if (!entry.name.endsWith('.d.ts') && !entry.name.endsWith('.min.js') && !entry.name.endsWith('.min.css')) {
              files.push(fullPath);
            }
          }
        }
      } catch {
        // skip
      }
    };

    if (dirs && dirs.length > 0) {
      // 目录过滤模式：只扫描指定的子目录
      for (const d of dirs) {
        const absDir = path.resolve(rootDir, d);
        await scanDir(absDir);
      }
    } else {
      // 全项目扫描
      await scanDir(rootDir);
    }
    return files;
  }

  /** 删除当前项目或指定项目的交叉引用数据库 */
  deleteDatabase(project?: string): string {
    let targetPath: string;
    if (project) {
      // 指定项目：支持绝对路径、相对路径、projectKey
      if (path.isAbsolute(project)) {
        const projectKey = toProjectKey(project);
        targetPath = path.join(os.homedir(), '.agent', 'cache', `xref-${projectKey}.sqlite`);
      } else if (project.includes('/') || project.includes('\\')) {
        // 相对路径 → 转绝对
        const projectKey = toProjectKey(path.resolve(project));
        targetPath = path.join(os.homedir(), '.agent', 'cache', `xref-${projectKey}.sqlite`);
      } else {
        // 直接传的 projectKey
        targetPath = path.join(os.homedir(), '.agent', 'cache', `xref-${project}.sqlite`);
      }
    } else {
      // 当前项目
      if (!this.dbPath) return 'Error: no xref database is currently open.';
      targetPath = this.dbPath;
    }

    // 关闭当前连接（如果删除的是当前项目）
    if (targetPath === this.dbPath) {
      this.db?.close();
      this.db = null;
      this.dbPath = '';
    }

    try {
      fs.unlink(targetPath);
      // macOS/Linux 的 WAL 也会产生 -wal 和 -shm 文件
      try { fs.unlink(targetPath + '-wal'); } catch {}
      try { fs.unlink(targetPath + '-shm'); } catch {}
      return `✅ Xref database deleted: ${targetPath}`;
    } catch {
      return `Database not found or already deleted: ${targetPath}`;
    }
  }

  // ── 路径工具 ────────────────────────────────────────────────────────

  private resolvePath(file: string): string {
    if (path.isAbsolute(file)) return file.replace(/\\/g, '/');
    return path.resolve(this.rootDir, file).replace(/\\/g, '/');
  }

  private toRelative(absPath: string): string {
    const normalized = absPath.replace(/\\/g, '/');
    const rootNormalized = this.rootDir.replace(/\\/g, '/');
    if (normalized.startsWith(rootNormalized + '/')) {
      return normalized.slice(rootNormalized.length + 1);
    }
    if (normalized.startsWith(rootNormalized)) {
      return normalized.slice(rootNormalized.length);
    }
    return normalized;
  }

  private async resolveImportPath(modulePath: string, fromFile: string): Promise<string | null> {
    if (!modulePath.startsWith('.')) return null; // 跳过非相对路径（npm 包等）
    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, modulePath);
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.java'];
    const resolvedNorm = resolved.replace(/\\/g, '/');

    // 精确匹配
    for (const ext of extensions) {
      const fullPath = resolvedNorm + ext;
      try {
        await fs.access(fullPath);
        return fullPath;
      } catch {
        // continue
      }
    }

    // index 文件
    for (const ext of extensions) {
      const indexPath = `${resolvedNorm}/index${ext}`;
      try {
        await fs.access(indexPath);
        return indexPath;
      } catch {
        // continue
      }
    }

    return null;
  }

  private guessLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript',
      '.js': 'javascript', '.jsx': 'javascript',
      '.py': 'python', '.go': 'go', '.rs': 'rust',
      '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
      '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
    };
    return map[ext] ?? 'unknown';
  }

  private shorten(text: string): string {
    if (text.length <= 30) return text;
    return text.slice(0, 13) + '...' + text.slice(-14);
  }

  /** 关闭数据库连接 */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
