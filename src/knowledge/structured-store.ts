/**
 * StructuredStore — 结构化知识库存储层
 *
 * 核心设计：
 *   entries 表存储 Agent 提炼后的结构化条目
 *   tag 子串匹配为主检索（用户输入.includes(tag)）
 *   FTS5 全文索引为兜底
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from '../tools/sqlite.js';
import type { SqliteDatabase } from '../tools/sqlite.js';

// ── 类型 ────────────────────────────────────────────────────────────

export type EntryCategory = 'api' | 'config' | 'guide' | 'reference' | 'code';

export interface StructuredEntry {
  id: string;
  title: string;
  tags: string[];
  category: EntryCategory;
  content: string;
  ctx_before: string;
  ctx_after: string;
  refs: string[];
  source: string;
  created_at: string;
  updated_at: string;
}

export interface TagMatchResult {
  entry: StructuredEntry;
  score: number;
  matchedTags: string[];
}

// ── Store ───────────────────────────────────────────────────────────

export class StructuredStore {
  private db: SqliteDatabase;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  // ── 建表 ────────────────────────────────────────────────────────

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        category    TEXT NOT NULL DEFAULT 'reference',
        content     TEXT NOT NULL,
        ctx_before  TEXT DEFAULT '',
        ctx_after   TEXT DEFAULT '',
        refs        TEXT NOT NULL DEFAULT '[]',
        source      TEXT DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        title, content, ctx_before, ctx_after, tags,
        content=entries,
        content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, content, ctx_before, ctx_after, tags)
        VALUES (new.rowid, new.title, new.content, new.ctx_before, new.ctx_after, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content, ctx_before, ctx_after, tags)
        VALUES('delete', old.rowid, old.title, old.content, old.ctx_before, old.ctx_after, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content, ctx_before, ctx_after, tags)
        VALUES('delete', old.rowid, old.title, old.content, old.ctx_before, old.ctx_after, old.tags);
        INSERT INTO entries_fts(rowid, title, content, ctx_before, ctx_after, tags)
        VALUES (new.rowid, new.title, new.content, new.ctx_before, new.ctx_after, new.tags);
      END;
    `);
  }

  // ── CRUD ────────────────────────────────────────────────────────

  add(entry: {
    id?: string;
    title: string;
    tags: string[];
    category?: EntryCategory;
    content: string;
    ctx_before?: string;
    ctx_after?: string;
    refs?: string[];
    source?: string;
  }): string {
    const id = entry.id || crypto.randomUUID();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    this.db.prepare(`
      INSERT INTO entries (id, title, tags, category, content, ctx_before, ctx_after, refs, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.title,
      JSON.stringify(entry.tags),
      entry.category || 'reference',
      entry.content,
      entry.ctx_before || '',
      entry.ctx_after || '',
      JSON.stringify(entry.refs || []),
      entry.source || '',
      now,
      now,
    );
    return id;
  }

  update(id: string, fields: Partial<{
    title: string;
    tags: string[];
    category: EntryCategory;
    content: string;
    ctx_before: string;
    ctx_after: string;
    refs: string[];
    source: string;
  }>): boolean {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(k === 'tags' || k === 'refs' ? JSON.stringify(v) : v);
      }
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    const r = this.db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return r.changes > 0;
  }

  remove(id: string): boolean {
    const r = this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    return r.changes > 0;
  }

  get(id: string): StructuredEntry | undefined {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEntry(row) : undefined;
  }

  list(category?: EntryCategory): StructuredEntry[] {
    if (category) {
      return (this.db.prepare('SELECT * FROM entries WHERE category = ? ORDER BY updated_at DESC').all(category) as Array<Record<string, unknown>>)
        .map(r => this.rowToEntry(r));
    }
    return (this.db.prepare('SELECT * FROM entries ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>)
      .map(r => this.rowToEntry(r));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
    return row.cnt;
  }

  /** 获取所有 tag（去重） */
  getAllTags(): string[] {
    const rows = this.db.prepare('SELECT tags FROM entries').all() as Array<{ tags: string }>;
    const tagSet = new Set<string>();
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.tags) as string[];
        for (const t of arr) tagSet.add(t);
      } catch { /* skip malformed */ }
    }
    return [...tagSet];
  }

  // ── 检索 ────────────────────────────────────────────────────────

  /**
   * Tag 子串匹配（IDF 加权 + 多 tag 累加）。
   * - 每个 tag 命中按 IDF 加权（稀有 tag 权重高，常见 tag 权重低）
   * - 多个 tag 命中则分数累加
   * - title 匹配额外加分（权重为查询命中的 30%）
   * 返回按 score 降序排列的结果。
   */
  matchByTags(query: string): TagMatchResult[] {
    const entries = this.list();
    if (entries.length === 0) return [];

    // 1. 计算每个 tag 的文档频率（DF）和逆文档频率（IDF）
    const df = new Map<string, number>();
    for (const entry of entries) {
      const seen = new Set<string>();
      for (const tag of entry.tags) {
        if (!seen.has(tag)) {
          df.set(tag, (df.get(tag) ?? 0) + 1);
          seen.add(tag);
        }
      }
    }
    const N = entries.length;
    const idf = new Map<string, number>();
    for (const [tag, freq] of df) {
      // IDF 平滑：加一平滑避免 N=freq 时归零，设下限 0.5 保证最小权重
      idf.set(tag, Math.max(Math.log((N + 1) / (freq + 0.5)), 0.5));
    }

    // 2. 打分：IDF 加权 × 基数 10，多 tag 命中累加
    const results: TagMatchResult[] = [];
    for (const entry of entries) {
      let score = 0;
      const matchedTags: string[] = [];
      for (const tag of entry.tags) {
        if (query.includes(tag)) {
          const weight = idf.get(tag) ?? 1;
          score += Math.round(10 * weight);
          matchedTags.push(tag);
        }
      }
      // title 匹配 → 额外加分（权重为查询命中的 30%）
      for (const tag of entry.tags) {
        if (entry.title.includes(tag) && !matchedTags.includes(tag)) {
          const weight = idf.get(tag) ?? 1;
          score += Math.round(3 * weight);
        }
      }
      if (matchedTags.length > 0) {
        results.push({ entry, score, matchedTags });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /** FTS5 全文搜索（兜底） */
  searchFts(query: string, k: number = 5): StructuredEntry[] {
    if (!query.trim()) return [];
    const safe = query.replace(/["*()]/g, '').trim();
    if (!safe) return [];

    try {
      const rows = this.db.prepare(`
        SELECT e.* FROM entries_fts f
        JOIN entries e ON e.rowid = f.rowid
        WHERE entries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(safe, k) as Array<Record<string, unknown>>;
      return rows.map(r => this.rowToEntry(r));
    } catch {
      return [];
    }
  }

  /** refs 链式扩展 */
  expandRefs(entries: StructuredEntry[]): StructuredEntry[] {
    const seen = new Set(entries.map(e => e.id));
    const extras: StructuredEntry[] = [];
    for (const e of entries) {
      for (const refId of e.refs) {
        if (seen.has(refId)) continue;
        const ref = this.get(refId);
        if (ref) {
          extras.push(ref);
          seen.add(refId);
        }
      }
    }
    return extras;
  }

  /** 组合检索：tag 匹配 → FTS5 兜底 → refs 扩展 */
  search(query: string, maxTotal = 5): TagMatchResult[] {
    const tagResults = this.matchByTags(query);
    // score > 0 即可纳入主结果，靠 IDF 排序 + maxTotal 截断保证精度
    const main = tagResults.filter(r => r.score > 0);

    if (main.length < 2) {
      const ftsEntries = this.searchFts(query, maxTotal);
      const existingIds = new Set(main.map(r => r.entry.id));
      for (const e of ftsEntries) {
        if (!existingIds.has(e.id)) {
          main.push({ entry: e, score: 5, matchedTags: [] });
          existingIds.add(e.id);
        }
      }
    }

    return main.slice(0, maxTotal);
  }

  // ── 格式化 ──────────────────────────────────────────────────────

  /** 将检索结果格式化为 Zone 4 注入文本 */
  formatResults(results: TagMatchResult[], maxMain = 3, maxRefs = 2): string {
    if (results.length === 0) return '';
    const lines = ['── 以下内容来自知识库 ──', ''];

    const main = results.slice(0, maxMain);
    const refs = results.slice(maxMain, maxMain + maxRefs);

    for (const r of main) {
      const tags = r.matchedTags.length > 0 ? `匹配标签: ${r.matchedTags.join(', ')}` : 'FTS5 匹配';
      lines.push(`(知识库提供) ━━ ${r.entry.id} ── [${r.entry.category}] ── ${tags}`);
      lines.push(r.entry.content);
      if (r.entry.ctx_before) lines.push(`前置: ${r.entry.ctx_before}`);
      if (r.entry.ctx_after) lines.push(`后续: ${r.entry.ctx_after}`);
      if (r.entry.refs.length > 0) lines.push(`关联: ${r.entry.refs.join(', ')}`);
      lines.push('');
    }

    if (refs.length > 0) {
      lines.push('── 补充（关联条目）──');
      for (const r of refs) {
        lines.push(`· ${r.entry.id}: ${r.entry.title} — ${r.entry.content.slice(0, 100)}`);
      }
      lines.push('');
    }

    lines.push('── 知识库内容结束 ──');
    return lines.join('\n');
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private rowToEntry(row: Record<string, unknown>): StructuredEntry {
    return {
      id: row.id as string,
      title: row.title as string,
      tags: JSON.parse(row.tags as string || '[]'),
      category: (row.category as EntryCategory) || 'reference',
      content: row.content as string,
      ctx_before: row.ctx_before as string || '',
      ctx_after: row.ctx_after as string || '',
      refs: JSON.parse(row.refs as string || '[]'),
      source: row.source as string || '',
      created_at: row.created_at as string || '',
      updated_at: row.updated_at as string || '',
    };
  }

  close(): void {
    this.db.close();
  }
}
