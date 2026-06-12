import fs from 'node:fs';
import path from 'node:path';
import type { KeywordEntry } from './types.js';

/**
 * 关键词池 — 管理 session 内累积的关键词
 * 每个 precise session 独立维护
 */
export class KeywordPool {
  private keywords: Map<string, number> = new Map();
  private filePath: string;

  constructor(sessionDir: string) {
    this.filePath = path.join(sessionDir, 'keywords.json');
    this.load();
  }

  /** 添加关键词（去重、加权重） */
  add(keyword: string, weight: number = 1): void {
    const existing = this.keywords.get(keyword) ?? 0;
    this.keywords.set(keyword, existing + weight);
  }

  /** 批量添加 */
  addAll(entries: KeywordEntry[]): void {
    for (const e of entries) {
      this.add(e.keyword, e.weight);
    }
  }

  /** 获取所有关键词（按权重降序） */
  getAll(): string[] {
    return [...this.keywords.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }

  /** 获取 Top N */
  getTop(n: number = 20): string[] {
    return this.getAll().slice(0, n);
  }

  /** 关键词数量 */
  size(): number {
    return this.keywords.size;
  }

  /** 持久化到磁盘 */
  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify([...this.keywords.entries()], null, 2),
        'utf-8',
      );
    } catch {}
  }

  /** 从磁盘加载 */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Array<[string, number]>;
        this.keywords = new Map(data);
      }
    } catch {}
  }

  /** 移除权重最低的关键词，保留 top N */
  prune(maxSize: number): void {
    if (this.keywords.size <= maxSize) return;
    const sorted = [...this.keywords.entries()].sort((a, b) => b[1] - a[1]);
    this.keywords = new Map(sorted.slice(0, maxSize));
    this.save();
  }
}
