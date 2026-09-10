/**
 * SayHistoryStore — 陪伴台词历史（companion_say 表达的文字记录）。
 *
 * 背景：companion_say 的表达经 COMPANION_SAY 事件实时推送给 UI，但**不落盘**——
 * 生成语音有 voices.sqlite（voiceList 可回放），纯文字台词（TTS 关闭/think 等）没有
 * 历史数据源，前端刷新后台词对话无法恢复。本存储补齐该缺口：
 *
 * - 文件：~/.agent/companion/say-history.sqlite（与 generated/voices.sqlite 同级）
 * - 表：say_history（sayId 与 COMPANION_VOICE 事件的 sayId 对齐，前端可对照）
 * - 写入点：companion_say 工具 execute + loop 兜底路径（模型未调工具时）
 * - 上限：每角色保留最近 DEFAULT_SAY_HISTORY_KEEP 条（写入时裁剪）
 * - 读取：companion.sayHistory 端点（角色维度，按时间倒序）
 */

import path from 'node:path';
import os from 'node:os';
import Database from '../tools/sqlite.js';
import type { SqliteDatabase } from '../tools/sqlite.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('companion:say-history');

export interface SayHistoryEntry {
  /** 表达唯一标识（与 COMPANION_SAY / COMPANION_VOICE 事件对齐） */
  sayId: string;
  character: string;
  mode: 'speak' | 'think';
  /** 台词全文（渲染格式 [动作]（内心）内容 或原始文本） */
  text: string;
  tone?: string;
  think?: string;
  action?: string;
  at: string; // ISO 8601
}

/** 每角色保留的最近台词条数（写入时裁剪） */
export const DEFAULT_SAY_HISTORY_KEEP = 500;

export class SayHistoryStore {
  private db: SqliteDatabase;
  private keep: number;

  constructor(baseDir?: string, keep = DEFAULT_SAY_HISTORY_KEEP) {
    const dir = baseDir ?? path.join(os.homedir(), '.agent', 'companion');
    this.keep = keep;
    this.db = Database(path.join(dir, 'say-history.sqlite'));
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS say_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          say_id TEXT NOT NULL,
          character TEXT NOT NULL,
          mode TEXT NOT NULL,
          text TEXT NOT NULL,
          tone TEXT,
          think TEXT,
          action TEXT,
          at TEXT NOT NULL
        )`,
      )
      .run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_say_char ON say_history(character, id DESC)').run();
  }

  /** 追加一条表达（幂等：同 sayId 已存在则跳过，防兜底路径与工具路径双写） */
  append(entry: SayHistoryEntry): void {
    const exists = this.db
      .prepare('SELECT 1 FROM say_history WHERE say_id = ? LIMIT 1')
      .get(entry.sayId) as { 1?: number } | undefined;
    if (exists) return;

    this.db
      .prepare(
        `INSERT INTO say_history (say_id, character, mode, text, tone, think, action, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.sayId, entry.character, entry.mode, entry.text, entry.tone ?? null, entry.think ?? null, entry.action ?? null, entry.at);

    // 每角色保留最近 keep 条（裁剪最旧的）
    this.db
      .prepare(
        `DELETE FROM say_history
         WHERE character = ? AND id NOT IN (
           SELECT id FROM say_history WHERE character = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(entry.character, entry.character, this.keep);

    logger.debug('say history appended', { sayId: entry.sayId, character: entry.character });
  }

  /** 按角色列出台词历史（时间倒序；before 用于分页游标） */
  listByCharacter(character: string, limit = 50, before?: string): SayHistoryEntry[] {
    if (before) {
      return this.db
        .prepare(
          `SELECT say_id AS sayId, character, mode, text, tone, think, action, at
           FROM say_history WHERE character = ? AND at < ? ORDER BY id DESC LIMIT ?`,
        )
        .all(character, before, limit) as unknown as SayHistoryEntry[];
    }
    return this.db
      .prepare(
        `SELECT say_id AS sayId, character, mode, text, tone, think, action, at
         FROM say_history WHERE character = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(character, limit) as unknown as SayHistoryEntry[];
  }

  /** 删除角色全部台词历史（角色删除时清理） */
  clearByCharacter(character: string): void {
    this.db.prepare('DELETE FROM say_history WHERE character = ?').run(character);
  }
}

let _singleton: SayHistoryStore | null = null;

/** 缺省全局单例（测试注入临时实例） */
export function getSayHistoryStore(): SayHistoryStore {
  _singleton ??= new SayHistoryStore();
  return _singleton;
}
