/**
 * Fts5Retriever — SQLite FTS5 全文检索实现
 *
 * 使用 Node 内置 node:sqlite（DatabaseSync）存储文档 + FTS5 虚拟表做 BM25 关键词检索。
 * 对 CJK 文本自动追加 bigram 到索引内容中，以支持中文搜索。
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Retriever, KbDocument, KbSearchResult } from './retriever.js';
import { preprocessQuery } from './query-preprocessor.js';
import Database from '../tools/sqlite.js';
import type { SqliteDatabase } from '../tools/sqlite.js';

// ── CJK bigram 分词 ────────────────────────────────────────────────

const CJK_RE = /[一-鿿㐀-䶿]/;

/** 将 CJK 文本转为空格分隔的二元组，追加到原文后面供 FTS5 索引 */
function indexContent(text: string): string {
  const bigrams: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (CJK_RE.test(ch) && i + 1 < text.length && CJK_RE.test(text[i + 1]!)) {
      bigrams.push(ch + text[i + 1]!);
    }
  }
  return bigrams.length > 0 ? text + '\n' + bigrams.join(' ') : text;
}

/** 将中文查询转为 bigram 格式用于 FTS5 MATCH */
function bigramQuery(query: string): string {
  const clean = query.replace(/["*()]/g, '').trim();
  // 非中文 → 直接返回
  if (!CJK_RE.test(clean)) return clean;
  // 中文 → 转为 bigram
  const bigrams: string[] = [];
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (CJK_RE.test(ch) && i + 1 < clean.length && CJK_RE.test(clean[i + 1]!)) {
      bigrams.push(`"${ch}${clean[i + 1]}"`);
    }
  }
  return bigrams.length > 0 ? bigrams.join(' ') : clean;
}

// ── Fts5Retriever ──────────────────────────────────────────────────

export class Fts5Retriever implements Retriever {
  readonly name = 'fts5';
  private db: SqliteDatabase;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
    this.migrateSchema();
    // 确保 FTS 索引与 docs 表同步
    this.db.exec("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')");
  }

  // ── 建表 ────────────────────────────────────────────────────────

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT DEFAULT '',
        content TEXT NOT NULL,
        fts_content TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        title, fts_content,
        content=docs,
        content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, title, fts_content) VALUES (new.rowid, new.title, new.fts_content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, title, fts_content) VALUES('delete', old.rowid, old.title, old.fts_content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, title, fts_content) VALUES('delete', old.rowid, old.title, old.fts_content);
        INSERT INTO docs_fts(rowid, title, fts_content) VALUES (new.rowid, new.title, new.fts_content);
      END;
    `);
  }

  /** 迁移旧 schema（bigram 列残留 / 缺少 fts_content 列） */
  private migrateSchema(): void {
    const ftsInfo = this.db.prepare("PRAGMA table_info('docs_fts')").all() as Array<{ name: string }>;
    const docInfo = this.db.prepare("PRAGMA table_info('docs')").all() as Array<{ name: string }>;
    const needsFtsRebuild = ftsInfo.some((c) => c.name === 'bigram');
    const needsFtsColumn = !docInfo.some((c) => c.name === 'fts_content');

    // 检查 fts_content 是否需要 backfill
    const emptyCount = this.db.prepare("SELECT COUNT(*) as cnt FROM docs WHERE fts_content = ''").get() as { cnt: number };
    const needsBackfill = emptyCount.cnt > 0;

    if (!needsFtsRebuild && !needsFtsColumn && !needsBackfill) return;

    // 1. 加 fts_content 列
    if (needsFtsColumn) {
      this.db.exec('ALTER TABLE docs ADD COLUMN fts_content TEXT NOT NULL DEFAULT \'\'');
    }

    // 2. Backfill fts_content
    if (needsBackfill) {
      const docs = this.db.prepare('SELECT rowid, content FROM docs').all() as Array<{ rowid: number; content: string }>;
      for (const d of docs) {
        this.db.prepare('UPDATE docs SET fts_content = ? WHERE rowid = ?').run(indexContent(d.content), d.rowid);
      }
    }

    // 3. 删除旧触发器，重建 FTS（如果需要），重建触发器
    this.db.exec('DROP TRIGGER IF EXISTS docs_ai; DROP TRIGGER IF EXISTS docs_ad; DROP TRIGGER IF EXISTS docs_au;');
    if (needsFtsRebuild) {
      this.db.exec('DROP TABLE IF EXISTS docs_fts');
      this.db.exec('CREATE VIRTUAL TABLE docs_fts USING fts5(title, fts_content, content=docs, content_rowid=rowid)');
    }
    this.db.exec(`
      CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, title, fts_content) VALUES (new.rowid, new.title, new.fts_content);
      END;
      CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, title, fts_content) VALUES('delete', old.rowid, old.title, old.fts_content);
      END;
      CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, title, fts_content) VALUES('delete', old.rowid, old.title, old.fts_content);
        INSERT INTO docs_fts(rowid, title, fts_content) VALUES (new.rowid, new.title, new.fts_content);
      END;
    `);

    // 4. 重建 FTS 索引（backfill 或 schema 变更后必须执行）
    this.db.exec("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')");
  }

  // ── 检索 ────────────────────────────────────────────────────────

  search(query: string, k: number = 5): KbSearchResult[] {
    if (!query.trim()) return [];

    // 中文查询 → 多策略降级
    if (CJK_RE.test(query)) {
      return this.searchCjk(query, k);
    }
    // 非中文 → 直接 FTS5 关键词
    return this.matchQuery(query, k);
  }

  /** 中文多策略搜索：按变体链降级 */
  private searchCjk(query: string, k: number): KbSearchResult[] {
    const { variants } = preprocessQuery(query);
    for (const v of variants) {
      const results = this.matchQuery(v, k);
      if (results.length > 0) return results;
    }
    return [];
  }

  /** 单次 FTS5 MATCH */
  private matchQuery(q: string, k: number): KbSearchResult[] {
    const safe = q.replace(/["*()]/g, '').trim();
    if (!safe) return [];

    const searchQuery = bigramQuery(safe);

    const stmt = this.db.prepare(`
      SELECT d.title, d.source,
        snippet(docs_fts, 1, '<b>', '</b>', '...', 40) AS snippet
      FROM docs_fts
      JOIN docs d ON d.rowid = docs_fts.rowid
      WHERE docs_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    try {
      const raw = stmt.all(searchQuery, k) as unknown as KbSearchResult[];
      // 去重（按 title+source）
      const seen = new Set<string>();
      return raw.filter(r => {
        const key = r.title + '|' + r.source;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch {
      return [];
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────

  add(doc: KbDocument): string {
    const id = doc.id || crypto.randomUUID();
    const ftsContent = indexContent(doc.content);
    this.db.prepare(
      'INSERT INTO docs (id, title, source, content, fts_content) VALUES (?, ?, ?, ?, ?)'
    ).run(id, doc.title, doc.source || '', doc.content, ftsContent);
    return id;
  }

  remove(id: string): boolean {
    const r = this.db.prepare('DELETE FROM docs WHERE id = ?').run(id);
    return r.changes > 0;
  }

  update(id: string, fields: Partial<Pick<KbDocument, 'title' | 'content' | 'source'>>): boolean {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    // content 更新 → 同步 fts_content
    if (fields.content !== undefined) {
      sets.push('fts_content = ?');
      vals.push(indexContent(fields.content));
    }
    if (sets.length === 0) return false;
    vals.push(id);
    const r = this.db.prepare(`UPDATE docs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return r.changes > 0;
  }

  findBySource(source: string): { id: string } | undefined {
    return this.db.prepare('SELECT id FROM docs WHERE source = ? LIMIT 1').get(source) as { id: string } | undefined;
  }

  list(): KbDocument[] {
    return this.db.prepare(
      'SELECT id, title, source, content, created_at FROM docs ORDER BY created_at DESC'
    ).all() as unknown as KbDocument[];
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM docs').get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
