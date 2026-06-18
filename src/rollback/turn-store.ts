/**
 * TurnStore — 环状缓冲区 + JSON 持久化
 *
 * 存储回合记录到 .agent/rollback/turn-{id}.json。
 * 最多保留 20 个回合，超出时淘汰最旧的。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TurnRecord, RollbackIndex } from './types.js';

const MAX_STORED_TURNS = 20;
const INDEX_FILE = 'index.json';

export class TurnStore {
  private storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
    this.ensureDir();
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** 保存回合记录，自动触发环状淘汰 */
  async save(record: TurnRecord): Promise<void> {
    this.ensureDir();

    // 写入单个回合文件
    const filePath = this.turnFilePath(record.turnId);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');

    // 更新索引
    const index = this.readIndex();
    if (!index.turns.includes(record.turnId)) {
      index.turns.push(record.turnId);
      index.turns.sort((a, b) => a - b);
    }
    index.lastTurnId = record.turnId;
    this.writeIndex(index);

    // 环状淘汰
    this.evictIfNeeded(index);
  }

  /** 按 turnId 加载单个回合记录 */
  async load(turnId: number): Promise<TurnRecord | null> {
    const filePath = this.turnFilePath(turnId);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TurnRecord;
    } catch {
      return null;
    }
  }

  /** 列出所有已存储的回合记录（按 turnId 升序） */
  async list(): Promise<TurnRecord[]> {
    const index = this.readIndex();
    const records: TurnRecord[] = [];
    for (const turnId of index.turns) {
      const record = await this.load(turnId);
      if (record) records.push(record);
    }
    return records;
  }

  /** 删除从 fromTurnId 开始的所有记录（含 fromTurnId），用于回滚后清理 */
  async deleteRange(fromTurnId: number): Promise<void> {
    const index = this.readIndex();
    const toRemove = index.turns.filter(id => id >= fromTurnId);

    for (const turnId of toRemove) {
      const filePath = this.turnFilePath(turnId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    index.turns = index.turns.filter(id => id < fromTurnId);
    this.writeIndex(index);
  }

  /** 获取存储目录路径 */
  getDir(): string {
    return this.storeDir;
  }

  // ── Private ────────────────────────────────────────────────────────

  private turnFilePath(turnId: number): string {
    return path.join(this.storeDir, `turn-${turnId}.json`);
  }

  private indexFilePath(): string {
    return path.join(this.storeDir, INDEX_FILE);
  }

  private readIndex(): RollbackIndex {
    const filePath = this.indexFilePath();
    if (!fs.existsSync(filePath)) {
      return { turns: [], lastTurnId: 0 };
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RollbackIndex;
    } catch {
      return { turns: [], lastTurnId: 0 };
    }
  }

  private writeIndex(index: RollbackIndex): void {
    fs.writeFileSync(this.indexFilePath(), JSON.stringify(index, null, 2), 'utf-8');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
  }

  /** 超过上限时删除最旧的回合文件 */
  private evictIfNeeded(index: RollbackIndex): void {
    while (index.turns.length > MAX_STORED_TURNS) {
      const oldest = index.turns.shift()!;
      const filePath = this.turnFilePath(oldest);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    this.writeIndex(index);
  }
}
