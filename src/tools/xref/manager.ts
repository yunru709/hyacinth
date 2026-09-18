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
import { SCHEMA_DDL, MIGRATION_ADD_MTIME } from './schema.js';
import type {
  BuildStats, QueryParams, GraphOptions, GraphFormat,
  XrefSymbol, XrefRef, XrefImport, XrefFile, ParsedFile,
} from './schema.js';
import { ParserRegistry, createParserRegistry } from './parser.js';
import { toProjectKey } from '../../utils/misc.js';
import Database from '../sqlite.js';
import type { SqliteDatabase } from '../sqlite.js';
import { statSync } from 'node:fs';

// ── 索引陈旧自检（2026-09-19）───────────────────────────────────────────
// 目的：让索引**知道自己旧不旧** —— 不是拒绝回答，而是**带标注回答**
//（成熟 IDE 的 "dumb mode" 最小版：宁可声明"结果可能不全"，不悄悄给看起来完整的答案）。
//
// 为什么不走"写工具通知"：那要求**每个生产者都配合并记得**（四个写工具 / bash / git /
// 外部编辑器 / 将来新增的工具），N 个生产者 × M 个消费者**必然漏**；并且会让核心写工具
// 反向依赖本插件（依赖方向倒挂：插件可以不存在，`init` 失败即 idle）。
// 故这里走**可观测性**：自己拿 files.mtime_ms 去 stat 磁盘比对 —— 改动来自谁都能发现。
//
// 判定口径**刻意与 build() 的增量跳过一致**（都用 mtime）：否则"检验器"与"构建器"会对
// "什么算变更"产生分歧。已知边界：**发现不了新增文件**（需遍历目录，成本过高）。
const STALE_CHECK_CAP = 5000;   // 单次最多 stat 多少个文件；超出则抽样并在提示中注明
const STALE_TTL_MS = 5000;      // 结果缓存 5s：查询密集时不必每次都 stat 上千文件

interface StaleCheck {
  at: number;
  total: number;    // files 表总行数
  checked: number;  // 本次实际 stat 的行数（< total 即抽样）
  stale: string[];  // 已变更（或已消失）的路径
  builtAt: string | null;
}

/** dbPath → 最近一次自检结果（多实例共库时共享，避免各查各的） */
const staleCacheByDb = new Map<string, StaleCheck>();

/** 把自检结果格式化成可直接拼在查询结果末尾的提示；新鲜则返回空串 */
function formatStaleNotice(s: StaleCheck): string {
  if (s.stale.length === 0) return '';
  const sample = s.stale.slice(0, 3).map((p) => p.replace(/^.*\//, '')).join(', ');
  const more = s.stale.length > 3 ? ` …(+${s.stale.length - 3})` : '';
  const sampled = s.total > s.checked ? `（抽样 ${s.checked}/${s.total}）` : '';
  return `\n\n⚠️ 索引可能陈旧${sampled}：检查的 ${s.checked} 个文件中有 ${s.stale.length} 个在索引后已变更（如 ${sample}${more}）。`
    + `\n   索引构建于 ${s.builtAt ?? '未知'}；结果可能不全（**不含新增文件**）→ 建议先运行 xref_build。`;
}

/**
 * 项目根合法性校验（2026-09-19，事故驱动）。
 *
 * 事故：插件把**裸 cwd** 当项目根（`xref-plugin.ts` 的 `init(services.cwd)`），而 agent
 * 可能从用户主目录启动。实测后果 —— `root=C:\Users\74689` → `projectKey=C-Users-74689`
 * → 产出 **1.18GB** 的索引（把 AppData、浏览器缓存全解析了一遍），且无人察觉，
 * 直到一次空间盘点才发现。
 *
 * 这里**只拒绝确定不合理的根**：主目录本身、以及主目录的祖先（含盘符根）。
 * 刻意**不**要求"必须有 package.json 之类的项目标记" —— 一个没有标记的脚本目录
 * 是完全合法的索引目标；把"像不像项目"当成准入条件会误伤。
 * 抛错发生在 `Database()` 之前，所以**连垃圾库文件都不会被创建**。
 */
function assertIndexableRoot(rootDir: string): void {
  const norm = (p: string): string => {
    const r = path.resolve(p).replace(/[/\\]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const root = norm(rootDir);
  const home = norm(os.homedir());

  if (root === home) {
    throw new Error(
      `拒绝索引用户主目录（${rootDir}）：这会把 AppData / 浏览器缓存等全部扫入索引 `
      + `（实测可产出 GB 级垃圾库）。请把 xref 指向真正的项目根，或从项目目录启动。`,
    );
  }
  if (home.startsWith(root + path.sep)) {
    throw new Error(
      `拒绝索引主目录的祖先目录（${rootDir}）：范围过大（如 C:\\Users、盘符根）。`
      + `请指向具体项目根。`,
    );
  }
}

/**
 * 路径单一规范：库里所有 path 一律存「正斜杠绝对路径」。
 *
 * 背景（修复）：扫描侧原用 `path.join`（Windows 下是反斜杠）入库，而查询/导入解析侧
 * 统一 `replace(/\\/g,'/')` —— 同一文件在 files 表出现两行（UNIQUE 只在字符串层面生效），
 * 于是 `deps` / `trace` 报 `File not in index`，文件计数也虚高。
 * 现在唯一入口是本函数，写入与查询共用同一规范。
 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 解析 imports.symbols。
 *
 * 写入侧存的是 `JSON.stringify(symbols)`（字符串），读取侧若直接当数组用会
 * `TypeError: imp.symbols.join is not a function`（修复：deps / dependents 原先就是这么崩的）。
 * 兼容数组形态（值可能来自未 stringify 的路径或外部注入）。
 */
function parseSymbols(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

export class XrefManager {
  private db: SqliteDatabase | null = null;
  private dbPath: string = '';
  private parserRegistry: ParserRegistry | null = null;
  private rootDir: string = '';
  /** 说明符解析缓存：key = `语言::所在目录::说明符`，同一目录下多个文件导入同一说明符只解析一次 */
  private resolveCache = new Map<string, string | null>();
  /** 项目内所有 go.mod（{dir, module 名}），undefined = 尚未探测 */
  private goModules: { dir: string; name: string }[] | undefined = undefined;

  /** 初始化数据库（创建 if not exists，运行 schema DDL） */
  async init(rootDir: string): Promise<void> {
    // 先校验根目录：不合理就抛错，**连垃圾库文件都不会被创建**（见 assertIndexableRoot 注释）
    assertIndexableRoot(rootDir);
    this.rootDir = rootDir;
    this.resolveCache.clear();
    this.goModules = undefined;
    const projectKey = toProjectKey(rootDir);
    const cacheDir = path.join(os.homedir(), '.agent', 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    this.dbPath = path.join(cacheDir, `xref-${projectKey}.sqlite`);

    this.db = Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // 多实例共库：同一项目可能被多个渠道的 LOOP 同时挂载 xref 插件，
    // 并发写（构建）时不设 busy_timeout 会直接 SQLITE_BUSY 抛错。
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA_DDL);
    this.migrate();
  }

  /** 幂等迁移：老库补 mtime_ms 列（CREATE TABLE IF NOT EXISTS 不会补列） */
  private migrate(): void {
    if (!this.db) return;
    const cols = this.db.prepare('PRAGMA table_info(files)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'mtime_ms')) {
      try {
        this.db.exec(MIGRATION_ADD_MTIME);
      } catch {
        // 并发迁移：另一个进程已补上则忽略
      }
    }
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

  /**
   * 索引陈旧自检 —— 设计说明见文件头 STALE_* 常量处。
   * 返回可直接拼在查询结果末尾的提示；索引新鲜（或未建库）时返回空串。
   *
   * **只读**：既不修改索引也不触发重建 —— "判断陈旧"与"修复陈旧"是两件事，
   * 混在一起会让查询变成隐式写操作（也就重新引入了本设计要避免的耦合）。
   */
  private stalenessNotice(): string {
    if (!this.db) return '';
    const now = Date.now();
    const cached = staleCacheByDb.get(this.dbPath);
    if (cached && now - cached.at < STALE_TTL_MS) return formatStaleNotice(cached);

    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c;
    // 只校验"解析过"的行（mtime_ms 非空）：仅被引用到的行从未写入 mtime，无从判定
    const rows = this.db
      .prepare('SELECT path, mtime_ms FROM files WHERE mtime_ms IS NOT NULL LIMIT ?')
      .all(STALE_CHECK_CAP) as { path: string; mtime_ms: number }[];

    const stale: string[] = [];
    for (const r of rows) {
      try {
        // 与 build() 同一口径（mtime）；1ms 容差吸收文件系统精度（同 write/edit 门控的做法）
        if (Math.abs(statSync(r.path).mtimeMs - r.mtime_ms) > 1) stale.push(r.path);
      } catch {
        stale.push(`${r.path}(已不存在)`);
      }
    }
    const builtAt = (this.db.prepare('SELECT value FROM meta WHERE key = ?').get('built_at') as { value: string } | undefined)?.value ?? null;
    const result: StaleCheck = { at: now, total, checked: rows.length, stale, builtAt };
    staleCacheByDb.set(this.dbPath, result);
    return formatStaleNotice(result);
  }

  // ── 构建索引 ────────────────────────────────────────────────────────

  /**
   * 构建/重建交叉引用索引。
   * @param changedFiles 可选：只重建这些文件（增量更新）。undefined = 扫描全项目并按需重建。
   * @param dirs        可选：只扫描这些子目录（相对路径）。undefined = 全项目扫描。
   * @param batchSize   每批解析并发数。
   * @param options.force  true = 忽略 mtime，全部重新解析（等价旧版"全量重建"）。
   *
   * 【同步构建】默认走 sync：扫描全项目 → 与库中 mtime 比对 → 只解析新增/变更的文件，
   * 并摘除已从磁盘消失的文件。这样"随手再跑一次 xref_build"代价极低，索引不会长期过期；
   * 旧版每次调用都清库重建（本项目 663 文件约 12s），导致 agent 不敢频繁调用、索引悄悄变旧。
   */
  async build(changedFiles?: string[], dirs?: string[], batchSize: number = 50, options?: { force?: boolean }): Promise<BuildStats> {
    if (!this.db) throw new Error('XrefManager not initialized. Call init() first.');

    const startedAt = Date.now();

    // 初始化 parser
    if (!this.parserRegistry) {
      this.parserRegistry = await createParserRegistry();
    }

    const force = options?.force === true;
    const isIncremental = !!changedFiles && changedFiles.length > 0;

    // 已入库的 path → mtime（sync 模式据此跳过未变更文件）
    const knownMtime = new Map<string, number | null>();
    for (const row of this.db.prepare('SELECT path, mtime_ms FROM files').all() as { path: string; mtime_ms: number | null }[]) {
      knownMtime.set(row.path, row.mtime_ms);
    }

    let filesToParse: string[] = [];
    const mtimeByPath = new Map<string, number>();
    let unchangedFiles = 0;
    let removedFiles = 0;
    let mode: 'full' | 'sync' | 'incremental';

    if (isIncremental) {
      // 增量：先按「规范化绝对路径」删除旧行。
      // 修复：原先直接用入参 f —— 相对路径（工具描述里的示例就是相对路径）既不匹配
      // 库里的绝对路径行（删不掉），又被 parser 按 process.cwd 解析（读不到），
      // 结果静默返回 0 文件。现统一按项目根解析 + 正斜杠规范。
      mode = 'incremental';
      const resolved = changedFiles!.map((f) => this.resolvePath(f));
      const deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      for (const f of resolved) {
        deleteFile.run(f);
      }
      filesToParse = resolved.filter(f => this.parserRegistry!.getParser(f) !== null);
      for (const f of filesToParse) {
        try {
          mtimeByPath.set(f, (await fs.stat(f)).mtimeMs);
        } catch {
          // 文件不存在：留 0，下一轮 sync 会把它摘掉
          mtimeByPath.set(f, 0);
        }
      }
    } else {
      mode = force ? 'full' : 'sync';
      const scanned = await this.scanFiles(this.rootDir, dirs);
      const onDisk = new Set<string>();
      for (const entry of scanned) {
        onDisk.add(entry.path);
        const prev = knownMtime.get(entry.path);
        if (!force && prev !== undefined && prev === entry.mtimeMs) {
          unchangedFiles++;
        } else {
          filesToParse.push(entry.path);
          mtimeByPath.set(entry.path, entry.mtimeMs);
        }
      }
      // 摘除已从磁盘消失的文件：仅在「全项目扫描」时做，
      // 否则目录过滤模式会把其它目录的索引行误删。
      if (!dirs || dirs.length === 0) {
        const deleteMissing = this.db.prepare('DELETE FROM files WHERE path = ?');
        for (const p of knownMtime.keys()) {
          if (!onDisk.has(p)) {
            deleteMissing.run(p);
            removedFiles++;
          }
        }
      }
    }

    // 批量解析
    // 用 INSERT（不是 INSERT OR REPLACE）：REPLACE 会换掉 id 并级联删除子行
    const insertFile = this.db.prepare(
      'INSERT INTO files (path, language, hash, last_parsed_at, mtime_ms) VALUES (?, ?, ?, ?, ?)',
    );
    const updateFile = this.db.prepare(
      'UPDATE files SET language = ?, hash = ?, last_parsed_at = ?, mtime_ms = ? WHERE path = ?',
    );
    const selectFileId = this.db.prepare('SELECT id FROM files WHERE path = ?');
    const insertSymbol = this.db.prepare(
      'INSERT INTO symbols (name, kind, file_id, line, col, signature, is_exported, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertRef = this.db.prepare(
      'INSERT INTO refs (symbol_name, file_id, line, col, kind, context, caller_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertImport = this.db.prepare(
      'INSERT INTO imports (from_file_id, to_file_id, symbols, import_type) VALUES (?, ?, ?, ?)',
    );

    let failedFiles = 0;
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
            // 不再静默吞掉：计入 failed_files，构建结果里可见
            failedFiles++;
            return null;
          }
        }),
      );
      for (const r of batchResults) {
        if (r) allParsed.push(r);
      }
    }

    // 预解析所有导入路径（异步操作，不能放在事务中）。
    //
    // 这里同时做「未解析导入」的归因：区分
    //   - external：npm 包 / 标准库 / 外部 crate —— 设计上不入图，不算缺失
    //   - unresolved：项目内说明符却没解析到 —— 这是图缺边，必须可见
    // 旧实现把两者一起静默丢弃，于是 imports=0 这种全盘失效无人察觉。
    const resolvedImports: Map<string, string | null> = new Map();
    const unresolvedKeys = new Set<string>();
    const unresolvedSamples: string[] = [];
    let externalImports = 0;

    for (const { file, data } of allParsed) {
      for (const imp of data.imports) {
        const key = `${normPath(file)}::${imp.to_path}`;
        if (resolvedImports.has(key)) continue;
        const resolved = await this.resolveImportPath(imp.to_path, file);
        resolvedImports.set(key, resolved);
        if (!resolved) {
          if (this.isIntraProjectSpecifier(imp.to_path, file)) {
            if (!unresolvedKeys.has(key) && unresolvedSamples.length < 10) {
              unresolvedSamples.push(`${this.toRelative(file)} → ${imp.to_path}`);
            }
            unresolvedKeys.add(key);
          } else {
            externalImports++;
          }
        }
      }
    }

    // 事务批量写入（同步操作）。
    //
    // 【两阶段】先为全部待解析文件建行并建立 path→id 映射，再写 symbols/refs/imports。
    // 为什么必须两阶段（修复）：files.path 是 UNIQUE，且子表都是 ON DELETE CASCADE。
    // 旧实现边遍历边补建「导入目标」行，用 INSERT OR REPLACE 会**替换掉已建行的 id**
    // 并级联删除其子行与指向它的导入边 —— 表现为同一文件被重复登记、
    // 导入边随机消失、deps/dependents/impact 结果不可信。
    // 现在建行只发生在阶段一，阶段二只读映射，不再触碰 files 行的身份。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doBatch = this.db.transaction((parsedFiles: { file: string; data: ParsedFile }[]) => {
      const now = new Date().toISOString();
      const fileIdByPath = new Map<string, number>();

      /**
       * 取/建文件行。
       * - meta 非空（=本次真的解析过它）：原位 UPDATE，写入 hash 与 mtime
       * - meta 为空（=只是被引用到的目标）：行已存在则**不动**（不能把已解析文件的
       *   hash/mtime 冲成 null），不存在才补建占位行
       * 绝不用 REPLACE —— 换 id 会级联删子行
       */
      const ensureFileId = (rawPath: string, language: string, meta: { hash: string; mtime: number } | null): number => {
        const p = normPath(rawPath);
        const cached = fileIdByPath.get(p);
        if (cached !== undefined) return cached;

        const row = selectFileId.get(p) as { id: number } | undefined;
        let id: number;
        if (row) {
          id = row.id;
          if (meta) updateFile.run(language, meta.hash, now, meta.mtime, p);
        } else {
          id = insertFile.run(p, language, meta?.hash ?? null, now, meta?.mtime ?? null).lastInsertRowid as number;
        }
        fileIdByPath.set(p, id);
        return id;
      };

      // ── 阶段一：全部文件行就位 ──
      for (const { file, data } of parsedFiles) {
        ensureFileId(file, data.language, { hash: data.hash, mtime: mtimeByPath.get(normPath(file)) ?? 0 });
      }

      // ── 阶段二：子表写入（fileId 一律取自映射） ──
      for (const { file, data } of parsedFiles) {
        const fileId = ensureFileId(file, data.language, { hash: data.hash, mtime: mtimeByPath.get(normPath(file)) ?? 0 });
        langBreakdown[data.language] = (langBreakdown[data.language] ?? 0) + 1;

        for (const sym of data.symbols) {
          insertSymbol.run(sym.name, sym.kind, fileId, sym.line, sym.col, sym.signature ?? null, sym.is_exported ? 1 : 0, sym.parent_name ?? null);
        }

        for (const ref of data.refs) {
          insertRef.run(ref.symbol_name, fileId, ref.line, ref.col, ref.kind, ref.context ?? null, ref.caller_name ?? null);
        }

        for (const imp of data.imports) {
          const resolved = resolvedImports.get(`${normPath(file)}::${imp.to_path}`);
          if (resolved) {
            const ext = path.extname(resolved).toLowerCase();
            const toFileId = ensureFileId(resolved, this.guessLanguage(ext), null);
            insertImport.run(fileId, toFileId, JSON.stringify(imp.symbols), imp.import_type);
          }
        }
      }
    });

    doBatch(allParsed);

    // 更新 meta
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('built_at', new Date().toISOString());
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('root_dir', this.rootDir);
    // 刚重建过 → 自检结果必然过期，清掉缓存；否则 TTL 窗口内会误报"新鲜"
    staleCacheByDb.delete(this.dbPath);

    // 统计一律取自库内实际行数，而不是「本次解析了多少」——
    // 否则 sync 模式下"全部未变"的那次构建会报 Symbols/Refs/Import edges = 0，
    // 看起来像把索引清空了。
    const count = (table: string): number =>
      (this.db!.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
    const indexed = count('files');
    const duration = Date.now() - startedAt;
    return {
      files: indexed,
      symbols: count('symbols'),
      refs: count('refs'),
      imports: count('imports'),
      duration_ms: duration,
      language_breakdown: langBreakdown,
      mode,
      parsed_files: allParsed.length,
      unchanged_files: unchangedFiles,
      removed_files: removedFiles,
      failed_files: failedFiles,
      unresolved_imports: unresolvedKeys.size,
      unresolved_samples: unresolvedSamples,
      external_imports: externalImports,
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

    let body: string;
    switch (params.action) {
      case 'refs':       body = this.queryRefs(params); break;
      case 'defs':       body = this.queryDefs(params); break;
      case 'callers':    body = this.queryCallers(params); break;
      case 'callees':    body = this.queryCallees(params); break;
      case 'deps':       body = this.queryDeps(params); break;
      case 'dependents': body = this.queryDependents(params); break;
      case 'hierarchy':  body = this.queryHierarchy(params); break;
      case 'impact':     body = this.queryImpact(params); break;
      case 'trace':        body = this.queryTrace(params); break;
      case 'symbol_search': body = this.querySymbolSearch(params); break;
      default:
        body = `Unknown action: "${params.action}". Supported: refs, defs, callers, callees, deps, dependents, hierarchy, impact, trace, symbol_search`;
    }
    // 结果照给，但**顺带告知索引是否陈旧**（不拒绝、不隐式重建 —— 见文件头 STALE_* 说明）
    return body + this.stalenessNotice();
  }

  /** 把可选的 file 参数解析成 file_id；文件不在索引中返回 null（区别于"未指定"= undefined） */
  private optionalFileId(file?: string): number | undefined | null {
    if (!file) return undefined;
    const row = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(this.resolvePath(file)) as { id: number } | undefined;
    return row ? row.id : null;
  }

  /**
   * 反向可达集合：从 defFileIds 出发，沿「谁导入了我」走 depth 跳，返回能到达定义文件的文件 id。
   *
   * 这是调用图"限定域"的基础。纯名字匹配会把项目里所有同名方法都算成调用者
   * （实测 `callers build` 会返回 vendor 打包产物里的 `t.build(a)`），
   * 而只有"确实能通过导入链拿到被调符号所在文件"的调用者才是可信的。
   */
  private reverseReachableFileIds(defFileIds: number[], depth: number): Set<number> {
    const reach = new Set<number>(defFileIds);
    if (defFileIds.length === 0) return reach;
    const placeholders = defFileIds.map(() => '?').join(',');
    const step = this.db!.prepare(
      `SELECT DISTINCT from_file_id FROM imports WHERE to_file_id IN (${placeholders})`,
    );
    let frontier = [...defFileIds];
    for (let d = 0; d < Math.max(1, depth); d++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const row of step.all(id) as { from_file_id: number }[]) {
          if (!reach.has(row.from_file_id)) {
            reach.add(row.from_file_id);
            next.push(row.from_file_id);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return reach;
  }

  private queryRefs(params: QueryParams): string {
    const { symbol } = params;
    if (!symbol) return 'Error: symbol is required for "refs" action.';

    const fileId = this.optionalFileId(params.file);
    if (fileId === null) return `File not in index: ${params.file}`;
    const scope = fileId !== undefined ? ' AND r.file_id = ?' : '';

    const rows = this.db!.prepare(
      `SELECT r.*, f.path as file_path FROM refs r
       JOIN files f ON r.file_id = f.id
       WHERE r.symbol_name = ?${scope}
       ORDER BY f.path, r.line
       LIMIT 200`,
    ).all(...(fileId !== undefined ? [symbol, fileId] : [symbol])) as (XrefRef & { file_path: string })[];

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

    const fileId = this.optionalFileId(params.file);
    if (fileId === null) return `File not in index: ${params.file}`;
    const scope = fileId !== undefined ? ' AND s.file_id = ?' : '';
    const kindScope = params.kind ? ' AND s.kind = ?' : ' AND 1=1';
    const bind: unknown[] = [symbol];
    if (fileId !== undefined) bind.push(fileId);
    if (params.kind) bind.push(params.kind);

    const rows = this.db!.prepare(
      `SELECT s.*, f.path as file_path FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.name = ?${scope}${kindScope}
       ORDER BY s.is_exported DESC, f.path`,
    ).all(...bind) as (XrefSymbol & { file_path: string })[];

    if (rows.length === 0) {
      // kind 过滤把结果清空 ≠ 符号不存在：说清"有哪些 kind 存在"，比笼统的 not found 有用得多
      if (params.kind) {
        const others = this.db!.prepare(
          `SELECT DISTINCT s.kind FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE s.name = ?${scope}
           ORDER BY s.kind`,
        ).all(...(fileId !== undefined ? [symbol, fileId] : [symbol])) as { kind: string }[];
        if (others.length > 0) {
          return `No definition of "${symbol}" with kind "${params.kind}". Existing kinds: ${others.map(o => o.kind).join(', ')}.`;
        }
      }
      return `No definition of "${symbol}" found.`;
    }

    const lines: string[] = [];
    lines.push(`Definition(s) of "${symbol}" (${rows.length}):`);
    for (const s of rows) {
      const shortPath = this.toRelative(s.file_path);
      const flags: string[] = [];
      if (s.is_exported) flags.push('exported');
      if (s.parent_name) flags.push(`in ${s.parent_name}`);
      const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';
      lines.push(`  [${s.kind}] ${shortPath}:${s.line}${flagStr}`);
      if (s.signature) lines.push(`    ${s.signature}`);
    }

    if (rows.length > 1) {
      lines.push(`Tip: use "kind" parameter to filter by type (function, class, method, etc.)`);
    }
    return lines.join('\n');
  }

  /**
   * 谁调用了该符号。
   *
   * 关键修复：旧实现是**纯名字匹配**（`refs WHERE symbol_name=? AND kind IN ('call','new')`），
   * 于是 `callers build` 会把 vendor 打包产物里的 `t.build(a)`、`promptBuilder.build()`
   * 这些**同名异实体**一并算成调用者 —— 空结果 agent 会去 grep 兜底，假阳性它不会。
   *
   * 现在用导入图做限定域：调用者文件必须能（经 depth 跳导入链，含桶文件透传）
   * 到达被调符号的定义文件，才算「已确认」；其余单列为「仅同名」，把不确定性摊开而不是藏起来。
   */
  private queryCallers(params: QueryParams): string {
    const { symbol } = params;
    if (!symbol) return 'Error: symbol is required for "callers" action.';

    const fileId = this.optionalFileId(params.file);
    if (fileId === null) return `File not in index: ${params.file}`;

    // file 的双重作用：
    //   ① 该文件里有这个符号的定义 → 把定义集缩到它（重名符号唯一有效的消歧手段：
    //      `build` 这种名字在几十个文件里都有定义，不消歧的话"已确认"仍会带上同名库的调用）
    //   ② 该文件里没有这个符号的定义 → 退化为"只看这个文件里的引用"，与 refs 一致
    const defRows = (fileId !== undefined
      ? this.db!.prepare('SELECT DISTINCT file_id FROM symbols WHERE name = ? AND file_id = ?').all(symbol, fileId)
      : this.db!.prepare('SELECT DISTINCT file_id FROM symbols WHERE name = ?').all(symbol)) as { file_id: number }[];
    const defFileIds = defRows.map((r) => r.file_id);
    const pinDefinition = fileId !== undefined && defFileIds.length > 0;
    const reach = this.reverseReachableFileIds(defFileIds, params.depth ?? 2);

    const refScope = fileId !== undefined && !pinDefinition ? fileId : undefined;
    const scope = refScope !== undefined ? ' AND r.file_id = ?' : '';
    const rows = this.db!.prepare(
      `SELECT r.*, f.path as file_path FROM refs r
       JOIN files f ON r.file_id = f.id
       WHERE r.symbol_name = ? AND r.kind IN ('call', 'new')${scope}
       ORDER BY f.path, r.line
       LIMIT 200`,
    ).all(...(refScope !== undefined ? [symbol, refScope] : [symbol])) as (XrefRef & { file_path: string })[];

    if (rows.length === 0) return `No callers of "${symbol}" found.`;

    const confirmed = rows.filter((r) => reach.has(r.file_id));
    const nameOnly = rows.filter((r) => !reach.has(r.file_id));

    const render = (r: XrefRef & { file_path: string }): string[] => {
      const callerInfo = r.caller_name ? ` (in ${r.caller_name})` : '';
      const out = [`  ${this.toRelative(r.file_path)}:${r.line}${callerInfo}`];
      if (r.context) out.push(`    ${r.context}`);
      return out;
    };

    const pinNote = pinDefinition ? ` [定义限定: ${this.toRelative(this.resolvePath(params.file!))}]` : '';
    const lines: string[] = [];
    lines.push(`Callers of "${symbol}" (${rows.length} name matches)${pinNote}:`);
    if (defFileIds.length === 0) {
      lines.push(`  ⚠ 索引中没有 "${symbol}" 的定义，无法用导入关系判定，下面全部只是同名匹配`);
    }

    if (confirmed.length > 0) {
      lines.push('');
      lines.push(`  ── 已确认 ${confirmed.length} 条（调用者文件经导入链可到达定义文件）──`);
      for (const r of confirmed) lines.push(...render(r));
    }
    if (nameOnly.length > 0) {
      lines.push('');
      lines.push(`  ── 仅同名 ${nameOnly.length} 条（与定义文件无导入关系，可能是同名异实体）──`);
      for (const r of nameOnly.slice(0, 30)) lines.push(...render(r));
      if (nameOnly.length > 30) lines.push(`  ... 另有 ${nameOnly.length - 30} 条同名匹配未列出`);
    }
    if (rows.length === 200) lines.push('  ... (truncated at 200 results)');
    return lines.join('\n');
  }

  private queryCallees(params: QueryParams): string {
    const { symbol } = params;
    if (!symbol) return 'Error: symbol is required for "callees" action.';

    const fileId = this.optionalFileId(params.file);
    if (fileId === null) return `File not in index: ${params.file}`;

    const maxDepth = params.depth ?? 1;
    const visited = new Set<string>();
    const output: string[] = [];
    output.push(`Callees of "${symbol}" (max depth: ${maxDepth}):`);

    this.traceCalleesRecursive(symbol, maxDepth, visited, output, 1, fileId);

    if (output.length === 1) {
      return `No callees found for "${symbol}". The function may have no calls or its body wasn't parsed.`;
    }
    return output.join('\n');
  }

  private traceCalleesRecursive(
    funcName: string, maxDepth: number, visited: Set<string>,
    output: string[], currentDepth: number, defFileId?: number,
  ): void {
    if (currentDepth > maxDepth || visited.has(funcName)) return;
    visited.add(funcName);

    // 定义文件的选择必须是确定的：同名符号可能多处置定义，
    // 旧的 `LIMIT 1` 不排序等于随机挑一个，同一个问题两次问可能给不同答案。
    let scopeFileId = defFileId;
    if (scopeFileId === undefined) {
      const symRow = this.db!.prepare(
        `SELECT s.file_id FROM symbols s
         WHERE s.name = ? AND s.kind IN ('function', 'method', 'arrow')
         ORDER BY s.is_exported DESC, s.file_id
         LIMIT 1`,
      ).get(funcName) as { file_id: number } | undefined;
      scopeFileId = symRow?.file_id;
    }
    if (scopeFileId === undefined) return;

    // 查找该文件中以该函数为 caller_name 的 call refs
    const calleeRows = this.db!.prepare(
      `SELECT DISTINCT r.symbol_name FROM refs r
       WHERE r.file_id = ? AND r.caller_name = ? AND r.kind = 'call'
       ORDER BY r.symbol_name
       LIMIT 50`,
    ).all(scopeFileId, funcName) as { symbol_name: string }[];

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
      lines.push(`  - ${this.toRelative(imp.to_path)}${this.formatImportType(imp)}${this.formatImportSymbols(imp)}`);
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
      lines.push(`  - ${this.toRelative(imp.from_path)}${this.formatImportType(imp)}${this.formatImportSymbols(imp)}`);
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

    // 语句提升到循环外：旧实现每访问一个节点都重新 prepare 两条 SQL，
    // 重复编译语句的开销在深图下超过查询本身。
    const selectFileId = this.db!.prepare('SELECT id FROM files WHERE path = ?');
    const selectDependents = this.db!.prepare(
      `SELECT DISTINCT f.path as from_path FROM imports i
       JOIN files f ON i.from_file_id = f.id
       WHERE i.to_file_id = ?
       ORDER BY f.path`,
    );

    // BFS: 查找依赖该文件的所有文件
    const visited = new Set<string>();
    const queue: { path: string; depth: number }[] = [{ path: resolved, depth: 0 }];
    visited.add(resolved);

    const layers: Map<number, string[]> = new Map();

    while (queue.length > 0) {
      const { path: current, depth: d } = queue.shift()!;
      if (d >= maxDepth) continue;

      const fileRow = selectFileId.get(current) as { id: number } | undefined;
      if (!fileRow) continue;

      const dependents = selectDependents.all(fileRow.id) as { from_path: string }[];

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

    // symbol 参数是**标注**而非过滤：影响面由文件导入关系决定，
    // 但知道"哪些受影响文件真的引用了这个符号"能帮调用方排优先级。
    // （旧实现只在标题里回显 symbol 名却完全不过滤 —— 工具描述里承诺的
    //  "Optional for: impact (filters by symbol)" 是空承诺。）
    const symbolFiles = new Set<string>();
    if (symbol) {
      const rows = this.db!.prepare(
        `SELECT DISTINCT f.path as p FROM refs r JOIN files f ON r.file_id = f.id WHERE r.symbol_name = ?`,
      ).all(symbol) as { p: string }[];
      for (const r of rows) symbolFiles.add(r.p);
    }

    const lines: string[] = [];
    const symSuffix = symbol ? ` — 标注引用 "${symbol}" 的文件` : '';
    lines.push(`Impact of changing ${this.toRelative(resolved)}${symSuffix} (max depth: ${maxDepth}):`);

    const sortedDepths = [...layers.keys()].sort((a, b) => a - b);
    let total = 0;
    let referencing = 0;
    for (const d of sortedDepths) {
      const files = layers.get(d)!;
      total += files.length;
      lines.push(`  Layer ${d} (${files.length} files):`);
      for (const f of files) {
        const mark = symbol && symbolFiles.has(f) ? '  ← 引用了该符号' : '';
        if (mark) referencing++;
        lines.push(`    - ${this.toRelative(f)}${mark}`);
      }
    }
    lines.push(`  Total: ${total} files across ${layers.size} layers`);
    if (symbol) lines.push(`  其中直接引用 "${symbol}" 的：${referencing} 个文件`);

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

    // 过滤：精确匹配符号名（复用 parseSymbols，容忍字符串/数组两种形态）
    const matched = rows.filter(r => parseSymbols(r.symbols).includes(symbol));

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

    let body: string;
    switch (format) {
      case 'mermaid':  body = this.graphMermaid(options, maxDepth); break;
      case 'text':     body = this.graphText(options, maxDepth); break;
      case 'graphviz': body = this.graphGraphviz(options, maxDepth); break;
      default:         body = `Unknown format: ${format}. Supported: text, mermaid, graphviz`;
    }
    // 同 query()：图也顺带告知索引是否陈旧
    return body + this.stalenessNotice();
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
      // 节点 id 不能用「把非法字符替换成 _」生成：`src/a/b.ts` 与 `src/a-b.ts`
      // 会撞成同一个 id，图里两个节点被合并。改用序号 id + 显示标签。
      const idMap = new Map<string, string>();
      let counter = 0;
      const nodeId = (x: string): string => {
        let id = idMap.get(x);
        if (id === undefined) {
          id = `n${counter++}`;
          idMap.set(x, id);
        }
        return id;
      };
      for (const [from, to] of edges) {
        nodeId(from);
        nodeId(to);
      }
      for (const [label] of idMap) {
        lines.push(`    ${nodeId(label)}["${this.escapeLabel(this.shorten(label))}"]`);
      }
      for (const [from, to, label] of edges) {
        lines.push(`    ${nodeId(from)} -->|${label}| ${nodeId(to)}`);
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
    const { symbol, file, direction } = options;
    const dir = direction ?? 'both';
    const lines: string[] = [];
    lines.push('```dot');
    lines.push('digraph G {');
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box, style=rounded];');

    const visited = new Set<string>();
    const edges: [string, string, string][] = [];

    if (symbol) {
      // 修复：旧实现无条件双向遍历，direction 参数被忽略
      if (dir === 'callers' || dir === 'both') {
        this.collectCallerEdges(symbol, maxDepth, visited, edges, 'calls');
      }
      if (dir === 'callees' || dir === 'both') {
        this.collectCalleeEdges(symbol, maxDepth, visited, edges, 'calls');
      }
    }
    // 修复：旧实现只处理 symbol，file 依赖图在 graphviz 格式下完全不可用
    if (file) {
      this.collectFileDepsEdges(file, maxDepth, visited, edges);
    }

    if (edges.length === 0) {
      lines.push('  empty [label="No relationships found"];');
    } else {
      const nodeIds = new Set<string>();
      for (const [from, to] of edges) { nodeIds.add(from); nodeIds.add(to); }
      for (const id of nodeIds) {
        lines.push(`  "${this.escapeLabel(id)}" [label="${this.escapeLabel(this.shorten(id))}"];`);
      }
      for (const [from, to, label] of edges) {
        lines.push(`  "${this.escapeLabel(from)}" -> "${this.escapeLabel(to)}" [label="${label}"];`);
      }
    }

    lines.push('}');
    lines.push('```');
    return lines.join('\n');
  }

  /** Mermaid/DOT 标签转义：引号会截断标签并破坏语法 */
  private escapeLabel(text: string): string {
    return text.replace(/"/g, "'");
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

    // 语句提升 + ORDER BY（DISTINCT 不带排序时行序不保证，同一张图两次生成可能不同）
    const selectFileId = this.db!.prepare('SELECT id FROM files WHERE path = ?');
    const selectImporters = this.db!.prepare(
      `SELECT DISTINCT f.path FROM imports i
       JOIN files f ON i.from_file_id = f.id
       WHERE i.to_file_id = ?
       ORDER BY f.path
       LIMIT 30`,
    );

    while (queue.length > 0) {
      const { path: current, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const fileRow = selectFileId.get(current) as { id: number } | undefined;
      if (!fileRow) continue;

      const deps = selectImporters.all(fileRow.id) as { path: string }[];

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
   * 扫描项目目录，收集需要解析的源文件及其 mtime。
   * @param dirs 可选：只扫描这些子目录（相对路径）。undefined = 全项目扫描。
   *
   * 性能：同层文件的 stat 并发发起、子目录串行下钻（避免一次性打开过多 fd）；
   * 旧实现是「每个 entry 一次串行 await readdir」，深目录下延迟叠加明显。
   */
  private async scanFiles(rootDir: string, dirs?: string[]): Promise<{ path: string; mtimeMs: number }[]> {
    const exts = this.parserRegistry?.getAllExtensions() ?? ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
    const extSet = new Set(exts);
    const files: { path: string; mtimeMs: number }[] = [];

    const scanDir = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      const subdirs: string[] = [];
      const pending: Promise<void>[] = [];
      for (const entry of entries) {
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', '.git', 'coverage', '.next', 'build', 'target', '__pycache__', '.venv', 'venv', '.agent'].includes(entry.name)) continue;
          if (entry.name.startsWith('.')) continue;
          subdirs.push(fullPath);
        } else if (extSet.has(path.extname(entry.name).toLowerCase())) {
          // 跳过类型声明与构建产物（.min.* 是打包器产物，索引它们只会污染符号表）
          if (!entry.name.endsWith('.d.ts') && !entry.name.includes('.min.')) {
            pending.push(
              fs.stat(fullPath)
                .then((s) => { files.push({ path: normPath(fullPath), mtimeMs: s.mtimeMs }); })
                .catch(() => { /* 读不到就跳过 */ }),
            );
          }
        }
      }
      await Promise.all(pending);
      for (const sub of subdirs) await scanDir(sub);
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

  /**
   * 删除当前项目或指定项目的交叉引用数据库。
   *
   * 修复：原实现是「同步签名 + 不 await 的 promise 版 fs.unlink」—— 删除是发射即忘，
   * 返回后文件可能仍在；且 WAL 库关闭时 SQLite 已自行清掉 -wal/-shm，
   * 对它们 unlink 必然 ENOENT 并产生**未处理 rejection**（每次 clean 两条）。
   * 现在：async + await，用 `fs.rm(..., { force: true })` 一次清三件套
   * （force 天然容忍不存在），并用 access 判定主库是否存在以保留两种返回文案。
   */
  async deleteDatabase(project?: string): Promise<string> {
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

    const existed = await fs.access(targetPath).then(() => true).catch(() => false);
    try {
      // WAL 模式会伴生 -wal / -shm；force 让三者可一次性清理且容忍缺失
      await Promise.all(
        [targetPath, `${targetPath}-wal`, `${targetPath}-shm`].map((p) => fs.rm(p, { force: true })),
      );
      return existed
        ? `✅ Xref database deleted: ${targetPath}`
        : `Database not found or already deleted: ${targetPath}`;
    } catch (err) {
      return `Error: cannot delete ${targetPath}: ${(err as Error).message}`;
    }
  }

  // ── 路径工具 ────────────────────────────────────────────────────────

  private resolvePath(file: string): string {
    if (path.isAbsolute(file)) return normPath(file);
    return normPath(path.resolve(this.rootDir, file));
  }

  private toRelative(absPath: string): string {
    const normalized = normPath(absPath);
    const rootNormalized = normPath(this.rootDir);
    if (normalized.startsWith(rootNormalized + '/')) {
      return normalized.slice(rootNormalized.length + 1);
    }
    if (normalized.startsWith(rootNormalized)) {
      return normalized.slice(rootNormalized.length);
    }
    return normalized;
  }

  /** imports 行的符号后缀（形如 ` {a, b}`；无符号返回空串） */
  private formatImportSymbols(imp: { symbols: unknown }): string {
    const syms = parseSymbols(imp.symbols);
    return syms.length > 0 ? ` {${syms.join(', ')}}` : '';
  }

  /**
   * 导入边类型后缀（形如 ` [reexport]`）。
   * 单列出来是因为语义差别很大：dependents 里出现 `[reexport]` 只说明"桶文件转发了它"，
   * 出现 `[static]`/`[dynamic]`/`[require]`/`[include]` 才是真的用了。
   */
  private formatImportType(imp: { import_type?: unknown }): string {
    const t = typeof imp.import_type === 'string' ? imp.import_type : '';
    return t ? ` [${t}]` : '';
  }

  /** 文件语言（按扩展名），解析策略据此分派 */
  private languageOf(file: string): string {
    return this.guessLanguage(path.extname(file).toLowerCase());
  }

  /**
   * 该说明符是否「本应解析到项目内」。
   * true  → 解析失败就是图缺边，计入 unresolved_imports（必须可见）
   * false → 外部依赖（npm 包 / 标准库 / 外部 crate），设计上不入图
   *
   * 旧实现把两者一起静默丢弃，于是 imports 恒为 0 也无人察觉。
   */
  private isIntraProjectSpecifier(spec: string, fromFile: string): boolean {
    if (spec.startsWith('.')) return true; // TS/JS/Python 相对、Go 的 ./pkg、C 的 ./x.h
    const lang = this.languageOf(fromFile);
    if (lang === 'rust') return /^(crate|self|super)::/.test(spec) || spec.startsWith('mod:');
    if (lang === 'c' || lang === 'cpp') return true; // 只采集引号形式（#include "x.h"），必为项目内
    return false;
  }

  /**
   * 说明符解析（带缓存）。
   * 缓存 key = `语言::所在目录::说明符`：同一目录下多个文件导入同一说明符只解析一次，
   * 旧实现每个 (文件, 说明符) 组合都要重跑一遍 fs.access 链。
   */
  private async resolveImportPath(modulePath: string, fromFile: string): Promise<string | null> {
    const dir = normPath(path.dirname(fromFile));
    const lang = this.languageOf(fromFile);
    const key = `${lang}::${dir}::${modulePath}`;
    const hit = this.resolveCache.get(key);
    if (hit !== undefined) return hit;
    const result = await this.resolveSpecifier(modulePath, dir, lang);
    this.resolveCache.set(key, result);
    return result;
  }

  /** 按语言分派说明符解析 */
  private async resolveSpecifier(spec: string, dir: string, lang: string): Promise<string | null> {
    switch (lang) {
      case 'typescript':
      case 'javascript':
        return spec.startsWith('.') ? this.resolveTsLike(spec, dir) : null;
      case 'python':
        return this.resolvePython(spec, dir);
      case 'go':
        return this.resolveGo(spec);
      case 'rust':
        return this.resolveRust(spec, dir);
      case 'c':
      case 'cpp':
        return this.resolveCInclude(spec, dir);
      case 'java':
      case 'kotlin':
        return this.resolveJavaLike(spec, lang);
      default:
        return spec.startsWith('.') ? this.resolveTsLike(spec, dir) : null;
    }
  }

  /** 依次尝试候选路径，返回首个存在的文件 */
  private async firstExisting(candidates: string[]): Promise<string | null> {
    for (const c of candidates) {
      try {
        const st = await fs.stat(c);
        if (st.isFile()) return normPath(c);
      } catch {
        // 不存在，试下一个
      }
    }
    return null;
  }

  /**
   * TS/JS 说明符解析 —— 本次最关键的一处修复。
   *
   * 旧实现只做「往路径尾部拼扩展名」，于是 `from './manager.js'` 会去找
   * `manager.js.ts` / `manager.js.js`，两条都不可能存在 ⇒ 永远 null。
   * 而 NodeNext / bundler 的通行约定是：说明符写 `./x.js`，源码实际是 `./x.ts`。
   * 本项目 2617 条相对导入全是这种写法，所以 imports 表恒为 0，
   * deps / dependents / impact / symbol_search / 文件依赖图全部空转。
   *
   * 现在按 Node 的解析顺序试：
   *   1) 原路径本身
   *   2) 去掉 .js/.mjs/.cjs/.jsx 后换 TS 扩展名（.js→.ts/.tsx，.mjs→.mts，.cjs→.cts）
   *   3) 原路径 + 各扩展名
   *   4) 当作目录 → <dir>/index.<ext>
   */
  private async resolveTsLike(spec: string, dir: string): Promise<string | null> {
    const base = normPath(path.resolve(dir, spec));
    const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
    const ALL_EXTS = [...TS_EXTS, '.js', '.jsx', '.mjs', '.cjs'];
    const candidates: string[] = [base];

    const esmSuffix = base.match(/\.(js|mjs|cjs|jsx)$/);
    if (esmSuffix) {
      const stem = base.slice(0, -esmSuffix[0].length);
      const mapped: string[] =
        esmSuffix[0] === '.mjs' ? ['.mts']
        : esmSuffix[0] === '.cjs' ? ['.cts']
        : esmSuffix[0] === '.jsx' ? ['.tsx', '.jsx']
        : ['.ts', '.tsx'];
      for (const e of mapped) candidates.push(stem + e);
    }

    for (const e of ALL_EXTS) candidates.push(base + e);
    for (const e of ALL_EXTS) candidates.push(`${base}/index${e}`);

    return this.firstExisting([...new Set(candidates)]);
  }

  /**
   * Python 说明符解析。
   * 旧实现把 `from .pkg import x` 的 `.pkg` 当相对路径拼接，去找 `<dir>/.pkg.py`
   * （带前导点的文件名），必然不命中；同时非相对导入完全不采集 ⇒ Python 依赖图此前整体为空。
   *
   * 现在按 PEP 328：前导点数是上跳层数（1 个点 = 当前包目录，2 个 = 上一级），
   * 其余按点拆成目录，兼容 `x.py` 与包目录 `x/__init__.py`；
   * 非相对说明符按项目根解析（解析不到即视作标准库/第三方，不计入缺失）。
   */
  private async resolvePython(spec: string, dir: string): Promise<string | null> {
    const root = normPath(this.rootDir);
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots);
    let baseDir = dir;
    for (let i = 1; i < dots; i++) baseDir = normPath(path.dirname(baseDir));

    const candidates: string[] = [];
    if (rest === '') {
      candidates.push(`${baseDir}/__init__.py`, `${baseDir}/__init__.pyi`);
    } else {
      const rel = rest.split('.').filter(Boolean).join('/');
      candidates.push(`${baseDir}/${rel}.py`, `${baseDir}/${rel}.pyi`, `${baseDir}/${rel}/__init__.py`);
    }
    if (dots === 0) {
      const rel = spec.split('.').filter(Boolean).join('/');
      candidates.push(`${root}/${rel}.py`, `${root}/${rel}/__init__.py`);
    }
    return this.firstExisting([...new Set(candidates)]);
  }

  /**
   * Go：模块路径 → 仓库内目录。
   * 优先按 go.mod 的 module 名剥前缀，其次直接按仓库根拼接；
   * 命中目录后取该目录下字典序第一个 .go 文件作代表（Go 是「目录=包」，
   * 依赖图本质上按目录理解更贴切，这里落成文件行以便复用文件级 BFS）。
   */
  private async resolveGo(spec: string): Promise<string | null> {
    const root = normPath(this.rootDir);
    const mods = await this.readGoModules();
    const dirCandidates: string[] = [];
    for (const mod of mods) {
      if (spec === mod.name || spec.startsWith(mod.name + '/')) {
        const rel = spec.slice(mod.name.length).replace(/^\//, '');
        dirCandidates.push(rel === '' ? mod.dir : `${mod.dir}/${rel}`);
      }
    }
    // 兜底：仓库根下按路径直接找（无 go.mod 或非模块化仓库）
    dirCandidates.push(`${root}/${spec}`);
    for (const dirCandidate of dirCandidates) {
      const picked = await this.firstFileInDir(dirCandidate, '.go');
      if (picked) return picked;
    }
    return null;
  }

  /** Rust：mod 声明 / crate:: / self:: / super:: 说明符（外部 crate 返回 null） */
  private async resolveRust(spec: string, dir: string): Promise<string | null> {
    const root = normPath(this.rootDir);
    let baseDir = dir;
    let rest = spec;
    let isModDecl = false;
    if (spec.startsWith('crate::')) {
      baseDir = `${root}/src`;
      rest = spec.slice('crate::'.length);
    } else if (spec.startsWith('self::')) {
      rest = spec.slice('self::'.length);
    } else if (spec.startsWith('super::')) {
      baseDir = normPath(path.dirname(dir));
      rest = spec.slice('super::'.length);
    } else if (spec.startsWith('mod:')) {
      isModDecl = true;
      rest = spec.slice('mod:'.length);
    } else if (!spec.startsWith('.')) {
      return null;
    }

    const segs = rest.split('::').filter(Boolean);
    if (isModDecl) {
      const name = segs[0] ?? rest;
      return this.firstExisting([`${baseDir}/${name}.rs`, `${baseDir}/${name}/mod.rs`]);
    }
    // use a::b::Thing → 逐级回退：a/b.rs / a/b/mod.rs → a.rs / a/mod.rs
    for (let n = segs.length; n >= 1; n--) {
      const rel = segs.slice(0, n).join('/');
      const hit = await this.firstExisting([`${baseDir}/${rel}.rs`, `${baseDir}/${rel}/mod.rs`]);
      if (hit) return hit;
    }
    return null;
  }

  /** C/C++：#include "x.h" —— 先同目录，再 include/，最后仓库根 */
  private async resolveCInclude(spec: string, dir: string): Promise<string | null> {
    const root = normPath(this.rootDir);
    const exts = path.extname(spec) ? [''] : ['.h', '.hpp', '.hxx'];
    const candidates: string[] = [];
    for (const base of [dir, `${root}/include`, root]) {
      for (const e of exts) candidates.push(`${base}/${spec}${e}`);
    }
    return this.firstExisting(candidates);
  }

  /** Java/Kotlin：com.foo.Bar → <source root>/com/foo/Bar.java|.kt */
  private async resolveJavaLike(spec: string, lang: string): Promise<string | null> {
    const root = normPath(this.rootDir);
    const rel = spec.replace(/^static\s+/, '').split('.').filter(Boolean).join('/');
    const exts = lang === 'kotlin' ? ['.kt'] : ['.java', '.kt'];
    const roots = [root, `${root}/src`, `${root}/src/main/java`, `${root}/src/main/kotlin`];
    const candidates: string[] = [];
    for (const r of roots) {
      for (const e of exts) candidates.push(`${r}/${rel}${e}`);
    }
    return this.firstExisting(candidates);
  }

  /** 目录下第一个指定扩展名的文件（字典序，保证多次构建结果稳定） */
  private async firstFileInDir(dirCandidate: string, ext: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dirCandidate, { withFileTypes: true });
      const hit = entries
        .filter((e) => e.isFile() && e.name.endsWith(ext))
        .map((e) => e.name)
        .sort()[0];
      return hit ? normPath(`${dirCandidate}/${hit}`) : null;
    } catch {
      return null;
    }
  }

  /**
   * 找出项目里所有 go.mod 及其 module 名（仓库根 + 一层子目录）。
   * 支持 monorepo：一个仓库里多个 Go 模块是常态，只看根部 go.mod 会漏掉全部子模块。
   */
  private async readGoModules(): Promise<{ dir: string; name: string }[]> {
    if (this.goModules) return this.goModules;
    const root = normPath(this.rootDir);
    const dirs = [root];
    try {
      for (const e of await fs.readdir(root, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          dirs.push(`${root}/${e.name}`);
        }
      }
    } catch {
      // 忽略
    }
    const mods: { dir: string; name: string }[] = [];
    for (const dir of dirs) {
      try {
        const content = await fs.readFile(`${dir}/go.mod`, 'utf-8');
        const m = content.match(/^\s*module\s+(\S+)/m);
        if (m) mods.push({ dir, name: m[1] });
      } catch {
        // 没有 go.mod
      }
    }
    this.goModules = mods;
    return mods;
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
