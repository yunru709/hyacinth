/**
 * GeneratedVoiceStore — 生成语音库（TTS 输出侧，供重放）。
 *
 * 三级索引（对齐产品约定）：
 *   一级   character（角色）
 *   二级   text_hash（规范化台词）+ emotion_key（规范化情绪）
 *   唯一键 (character, text_hash, emotion_key, voice_id) → 天然去重/缓存命中
 *   （provider/model 不入唯一键：换供应商重新合成，旧条目保留可切回）
 *
 * 音频本体不进 sqlite（blob 使库膨胀、备份重）：库存元数据 + 相对路径，
 * 文件按角色分目录存放。查询主路径就是唯一键索引查询。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Database from '../tools/sqlite.js';
import type { SqliteDatabase } from '../tools/sqlite.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('companion:voice-store');

export interface GeneratedVoiceRow {
  id: string;
  character: string;
  /** 规范化台词全文（回放列表展示） */
  textNorm: string;
  /** 规范化文本 sha256 前16（二级索引） */
  textHash: string;
  /** 规范化情绪（''=中性） */
  emotionKey: string;
  /** tone 原文 */
  emotionRaw?: string;
  /** 音色库条目 id（''=config 直配路径/供应商原生音色） */
  voiceId: string;
  /** 音色名快照 */
  voiceName?: string;
  provider: string;
  model?: string;
  format: string;
  byteSize: number;
  durationMs?: number;
  relPath: string;
  createdAt: string;
}

export interface InsertGeneratedVoice {
  character: string;
  textNorm: string;
  textHash: string;
  emotionKey?: string;
  emotionRaw?: string;
  voiceId?: string;
  voiceName?: string;
  provider: string;
  model?: string;
  format: string;
  byteSize: number;
  durationMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS generated_voices (
  id           TEXT PRIMARY KEY,
  character    TEXT NOT NULL,
  text_norm    TEXT NOT NULL,
  text_hash    TEXT NOT NULL,
  emotion_key  TEXT NOT NULL DEFAULT '',
  emotion_raw  TEXT,
  voice_id     TEXT NOT NULL DEFAULT '',
  voice_name   TEXT,
  provider     TEXT NOT NULL,
  model        TEXT,
  format       TEXT NOT NULL,
  byte_size    INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  rel_path     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gv_char ON generated_voices(character, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gv_key
  ON generated_voices(character, text_hash, emotion_key, voice_id);
`;

export class GeneratedVoiceStore {
  private db: SqliteDatabase;
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.agent', 'companion', 'generated');
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.db = Database(path.join(this.baseDir, 'voices.sqlite'));
    this.db.exec(SCHEMA);
  }

  /** 按唯一键查询（缓存命中） */
  find(character: string, textHash: string, emotionKey = '', voiceId = ''): GeneratedVoiceRow | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM generated_voices WHERE character = ? AND text_hash = ? AND emotion_key = ? AND voice_id = ? LIMIT 1',
      )
      .get(character, textHash, emotionKey, voiceId) as Record<string, unknown> | undefined;
    return row ? this.toRow(row) : undefined;
  }

  get(id: string): GeneratedVoiceRow | undefined {
    const row = this.db.prepare('SELECT * FROM generated_voices WHERE id = ? LIMIT 1').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toRow(row) : undefined;
  }

  /** 按角色列出（倒序，重放列表用） */
  listByCharacter(character: string, limit = 50): GeneratedVoiceRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM generated_voices WHERE character = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(character, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  /**
   * 条目 id：必须覆盖**完整**唯一键 (character, text_hash, emotion_key, voice_id)。
   * 若只由 textHash+emotion 生成，「不同角色 / 不同音色说同一句台词」会撞
   * PRIMARY KEY（UNIQUE constraint failed）并抛错 —— id 与唯一键粒度必须一致。
   */
  private makeId(e: InsertGeneratedVoice): string {
    const key = [e.character, e.textHash, e.emotionKey ?? '', e.voiceId ?? ''].join('|');
    return 'gv_' + createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 16);
  }

  /**
   * 插入条目并把音频文件收纳进库目录（<baseDir>/<角色>/<id>.<ext>）。
   * 唯一键冲突返回已有条目（幂等）。
   */
  insert(srcPath: string, e: InsertGeneratedVoice): GeneratedVoiceRow {
    const existing = this.find(e.character, e.textHash, e.emotionKey ?? '', e.voiceId ?? '');
    if (existing) return existing;

    const id = this.makeId(e);
    const charDir = path.join(this.baseDir, e.character.replace(/[\\/:*?"<>|]/g, '_'));
    fs.mkdirSync(charDir, { recursive: true });
    const fileName = id + '.' + (e.format || 'wav');
    const abs = path.join(charDir, fileName);
    fs.copyFileSync(srcPath, abs);
    const relPath = path.relative(this.baseDir, abs).replace(/\\/g, '/');

    try {
      this.db
        .prepare(
          `INSERT INTO generated_voices
           (id, character, text_norm, text_hash, emotion_key, emotion_raw, voice_id, voice_name,
            provider, model, format, byte_size, duration_ms, rel_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          e.character,
          e.textNorm,
          e.textHash,
          e.emotionKey ?? '',
          e.emotionRaw ?? null,
          e.voiceId ?? '',
          e.voiceName ?? null,
          e.provider,
          e.model ?? null,
          e.format,
          e.byteSize,
          e.durationMs ?? null,
          relPath,
          new Date().toISOString(),
        );
    } catch (err) {
      // 唯一键冲突（并发/重复）→ 返回已有条目
      const found = this.find(e.character, e.textHash, e.emotionKey ?? '', e.voiceId ?? '');
      if (found) return found;
      throw err;
    }
    logger.info('voice stored', { id, character: e.character, byteSize: e.byteSize });
    return this.get(id)!;
  }

  /** 音频文件绝对路径 */
  filePathOf(row: GeneratedVoiceRow): string {
    return path.join(this.baseDir, row.relPath);
  }

  /**
   * 容量统计（管理面板用）：总条数 / 总字节 / 按角色分布（按占用降序）。
   * 注意统计的是**索引里记录**的字节数，与磁盘实际占用可能有小偏差。
   */
  stats(): {
    count: number;
    totalBytes: number;
    byCharacter: Array<{ character: string; count: number; bytes: number }>;
  } {
    const total = this.db
      .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(byte_size), 0) AS b FROM generated_voices')
      .get() as { c?: number; b?: number } | undefined;
    const rows = this.db
      .prepare(
        'SELECT character, COUNT(*) AS c, COALESCE(SUM(byte_size), 0) AS b' +
          ' FROM generated_voices GROUP BY character ORDER BY b DESC',
      )
      .all() as Array<{ character: string; c?: number; b?: number }>;
    return {
      count: Number(total?.c ?? 0),
      totalBytes: Number(total?.b ?? 0),
      byCharacter: rows.map((r) => ({
        character: String(r.character),
        count: Number(r.c ?? 0),
        bytes: Number(r.b ?? 0),
      })),
    };
  }

  /** 清理：按角色保留最近 keepN 条（删除库条目与文件），返回删除数 */
  prune(character: string, keepN: number): number {
    const rows = this.listByCharacter(character, 100000);
    if (rows.length <= keepN) return 0;
    let removed = 0;
    for (const row of rows.slice(keepN)) {
      try {
        const abs = this.filePathOf(row);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch { /* ignore */ }
      this.db.prepare('DELETE FROM generated_voices WHERE id = ?').run(row.id);
      removed++;
    }
    return removed;
  }

  private toRow(r: Record<string, unknown>): GeneratedVoiceRow {
    return {
      id: String(r.id),
      character: String(r.character),
      textNorm: String(r.text_norm ?? ''),
      textHash: String(r.text_hash ?? ''),
      emotionKey: String(r.emotion_key ?? ''),
      emotionRaw: r.emotion_raw ? String(r.emotion_raw) : undefined,
      voiceId: String(r.voice_id ?? ''),
      voiceName: r.voice_name ? String(r.voice_name) : undefined,
      provider: String(r.provider ?? ''),
      model: r.model ? String(r.model) : undefined,
      format: String(r.format ?? 'wav'),
      byteSize: Number(r.byte_size ?? 0),
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
      relPath: String(r.rel_path ?? ''),
      createdAt: String(r.created_at ?? ''),
    };
  }
}

/**
 * 容量治理默认值：每角色保留最近多少条生成语音（0 = 不清理）。
 * 放在数据层，协议层与语音服务共用，避免协议层反向依赖服务层。
 */
export const DEFAULT_KEEP_PER_CHARACTER = 300;

let _instance: GeneratedVoiceStore | null = null;

/** 全局实例（目录固定 ~/.agent/companion/generated；测试用 new GeneratedVoiceStore(dir)） */
export function getGeneratedVoiceStore(): GeneratedVoiceStore {
  if (!_instance) _instance = new GeneratedVoiceStore();
  return _instance;
}
