import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionStats } from '../types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('stats');

const DEFAULT_STATS: SessionStats = {
  input_tokens: 0,
  output_tokens: 0,
  turn_count: 0,
  compact_count: 0,
  current_context_tokens: 0,
};

export class StatsManager {
  private readonly statsFile: string;

  constructor(statsFile: string = 'stats.json') {
    this.statsFile = statsFile;
  }

  private getFilePath(sessionDir: string): string {
    return path.join(sessionDir, this.statsFile);
  }
  /**
   * 初始化 stats.json
   */
  async init(sessionDir: string): Promise<void> {
    const filePath = this.getFilePath(sessionDir);
    await fs.writeFile(filePath, JSON.stringify(DEFAULT_STATS, null, 2), 'utf-8');
  }

  /**
   * 更新指定字段
   */
  async update(sessionDir: string, updates: Partial<SessionStats>): Promise<void> {
    const current = await this.get(sessionDir);
    const merged: SessionStats = { ...current, ...updates };
    const filePath = this.getFilePath(sessionDir);
    await this.safeWrite(filePath, JSON.stringify(merged, null, 2));
  }

  /**
   * 读取当前 stats
   */
  async get(sessionDir: string): Promise<SessionStats> {
    const filePath = this.getFilePath(sessionDir);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as SessionStats;
    } catch {
      return { ...DEFAULT_STATS };
    }
  }

  /**
   * 增加指定字段
   */
  async increment(sessionDir: string, field: keyof SessionStats, value = 1): Promise<void> {
    const current = await this.get(sessionDir);
    const currentValue = current[field];
    // SessionStats 的所有字段都是 number 类型
    (current[field] as number) = (currentValue as number) + value;
    const filePath = this.getFilePath(sessionDir);
    await this.safeWrite(filePath, JSON.stringify(current, null, 2));
  }

  /**
   * 安全写入：目录缺失时自动重建，异常不传播
   */
  private async safeWrite(filePath: string, content: string): Promise<void> {
    try {
      await fs.writeFile(filePath, content, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 目录可能被清理/不存在 → 尝试重建
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, 'utf-8');
        } catch (retryErr) {
          logger.warn('Failed to write stats after directory recreation', {
            path: filePath,
            error: (retryErr as Error).message,
          });
        }
      } else {
        logger.warn('Failed to write stats', {
          path: filePath,
          error: (err as Error).message,
        });
      }
    }
  }
}
