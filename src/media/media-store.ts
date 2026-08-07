/**
 * MediaStore — 媒体库（独立于知识库的媒体索引 + 文件管理）
 *
 * 设计目标：
 *  - 独立数据库（media.sqlite），与知识库（kb.sqlite）完全隔离——用户删除知识库数据不影响媒体库
 *  - 文件本体统一存 ~/.agent/media/files/，SQLite 只存元数据索引
 *  - 供 scene_render 产物、generate_image/video 产物回填，WebUI 经 serve 端点查询
 *
 * 存储位置：
 *  - 数据库：~/.agent/media/media.sqlite
 *  - 文件：  ~/.agent/media/files/<id>.<ext>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from '../tools/sqlite.js';
import type { SqliteDatabase } from '../tools/sqlite.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('media');

// ── 位置 ────────────────────────────────────────────────────────────

/** 媒体库根目录：~/.agent/media/ */
export function getMediaDir(): string {
  return path.join(os.homedir(), '.agent', 'media');
}

/** 数据库路径：~/.agent/media/media.sqlite */
export function getMediaDbPath(): string {
  return path.join(getMediaDir(), 'media.sqlite');
}

/** 文件目录：~/.agent/media/files/ */
export function getMediaFilesDir(): string {
  return path.join(getMediaDir(), 'files');
}

// ── 类型 ────────────────────────────────────────────────────────────

export type MediaType = 'image' | 'video' | 'audio';

/** 媒体来源 */
export type MediaSource = 'scene' | 'generation' | 'user';

export interface MediaEntry {
  /** 媒体类型 */
  type: MediaType;
  /** 来源：scene（场景渲染）/ generation（生成工具）/ user（用户上传） */
  source: MediaSource;
  /** 归属角色（陪伴场景），可选 */
  character?: string;
  /** 生成任务类型（如 text_to_image / text_to_video），可选 */
  taskType?: string;
  /** 去重签名（scene_desc 规范化 hash 等） */
  signature?: string;
  /** 生成提示词 */
  prompt?: string;
  /** 扩展元数据（JSON 字符串） */
  meta?: string;
  /** 创建时间（ISO） */
  createdAt?: string;
}

export interface MediaRecord extends MediaEntry {
  /** 唯一 ID */
  id: string;
  /** 相对 media 根的文件路径（files/xxx.png） */
  relPath: string;
}

/** 查询过滤器 */
export interface MediaFilter {
  type?: MediaType;
  source?: MediaSource;
  character?: string;
  limit?: number;
}

// ── 实现 ────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  source     TEXT NOT NULL,
  character  TEXT,
  task_type  TEXT,
  signature  TEXT,
  prompt     TEXT,
  meta       TEXT,
  rel_path   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
CREATE INDEX IF NOT EXISTS idx_media_source ON media(source);
CREATE INDEX IF NOT EXISTS idx_media_character ON media(character);
`;

export class MediaStore {
  private db: SqliteDatabase;
  private filesDir: string;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? getMediaDbPath();
    const dir = path.dirname(this.dbPath);
    this.filesDir = path.join(dir, 'files');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = Database(this.dbPath);
    this.db.exec(SCHEMA);
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }

  /**
   * 导入文件到媒体库（复制进 files/ 并登记索引）。
   * @param srcPath 源文件绝对路径
   * @param entry 元数据
   * @returns 媒体记录 ID
   */
  importFile(srcPath: string, entry: Omit<MediaEntry, 'type'> & { type: MediaType }): MediaRecord {
    if (!fs.existsSync(srcPath)) {
      throw new Error(`media import: source not found: ${srcPath}`);
    }
    const ext = path.extname(srcPath) || inferExt(entry.type);
    const id = randomUUID();
    const relPath = path.posix.join('files', `${id}${ext}`);
    const dest = path.join(this.filesDir, `${id}${ext}`);
    fs.copyFileSync(srcPath, dest);

    const rec: MediaRecord = {
      id,
      ...entry,
      relPath,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO media (id, type, source, character, task_type, signature, prompt, meta, rel_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.type,
        rec.source,
        rec.character ?? null,
        rec.taskType ?? null,
        rec.signature ?? null,
        rec.prompt ?? null,
        rec.meta ?? null,
        rec.relPath,
        rec.createdAt!,
      );
    return rec;
  }

  /**
   * 登记已存在于媒体目录的文件（不复制）。
   * @param relPath 相对媒体根的文件路径（如 files/xxx.png）
   */
  register(relPath: string, entry: Omit<MediaEntry, 'type'> & { type: MediaType }): MediaRecord {
    const id = randomUUID();
    const rec: MediaRecord = {
      id,
      ...entry,
      relPath,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO media (id, type, source, character, task_type, signature, prompt, meta, rel_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.type,
        rec.source,
        rec.character ?? null,
        rec.taskType ?? null,
        rec.signature ?? null,
        rec.prompt ?? null,
        rec.meta ?? null,
        rec.relPath,
        rec.createdAt!,
      );
    return rec;
  }

  /** 按 ID 查询 */
  get(id: string): MediaRecord | undefined {
    const row = this.db.prepare('SELECT * FROM media WHERE id = ?').get(id);
    return row ? rowToRecord(row) : undefined;
  }

  /** 按签名查（去重用：签名存在且同来源同角色 → 已入库） */
  findBySignature(signature: string, source: MediaSource, character?: string): MediaRecord | undefined {
    const row = character
      ? this.db
          .prepare('SELECT * FROM media WHERE signature = ? AND source = ? AND character = ? LIMIT 1')
          .get(signature, source, character)
      : this.db
          .prepare('SELECT * FROM media WHERE signature = ? AND source = ? LIMIT 1')
          .get(signature, source);
    return row ? rowToRecord(row) : undefined;
  }

  /** 列表查询 */
  list(filter: MediaFilter = {}): MediaRecord[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.type) {
      conds.push('type = ?');
      params.push(filter.type);
    }
    if (filter.source) {
      conds.push('source = ?');
      params.push(filter.source);
    }
    if (filter.character) {
      conds.push('character = ?');
      params.push(filter.character);
    }
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    const limit = filter.limit && filter.limit > 0 ? ` LIMIT ${filter.limit}` : '';
    const rows = this.db.prepare(`SELECT * FROM media${where} ORDER BY created_at DESC${limit}`).all(...params);
    return rows.map(rowToRecord);
  }

  /** 删除记录（可选同时删文件） */
  remove(id: string, deleteFile = true): boolean {
    const rec = this.get(id);
    if (!rec) return false;
    this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
    if (deleteFile) {
      const abs = path.join(path.dirname(this.dbPath), rec.relPath);
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch (err) {
        logger.warn(`media remove: failed to delete file ${abs}: ${(err as Error).message}`);
      }
    }
    return true;
  }

  /** 记录数 */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM media').get();
    return row ? Number(row.n) : 0;
  }

  /** 解析媒体文件绝对路径 */
  resolvePath(rec: Pick<MediaRecord, 'relPath'>): string {
    return path.join(path.dirname(this.dbPath), rec.relPath);
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function rowToRecord(row: Record<string, unknown>): MediaRecord {
  return {
    id: String(row.id),
    type: row.type as MediaType,
    source: row.source as MediaSource,
    character: row.character ? String(row.character) : undefined,
    taskType: row.task_type ? String(row.task_type) : undefined,
    signature: row.signature ? String(row.signature) : undefined,
    prompt: row.prompt ? String(row.prompt) : undefined,
    meta: row.meta ? String(row.meta) : undefined,
    relPath: String(row.rel_path),
    createdAt: String(row.created_at),
  };
}

function inferExt(type: MediaType): string {
  switch (type) {
    case 'image':
      return '.png';
    case 'video':
      return '.mp4';
    case 'audio':
      return '.mp3';
  }
}
