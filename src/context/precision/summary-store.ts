import fs from 'node:fs';
import path from 'node:path';
import type { TurnSummary } from './analyzer.js';

/**
 * SummaryStore — 摘要持久化存储。
 * 负责 JSON 序列化、去重合并、容量限制。
 * 与 KeywordPool 平级，供 PreciseStrategy 使用。
 */
export class SummaryStore {
  private items: TurnSummary[] = [];
  private filePath: string;

  constructor(sessionDir: string) {
    this.filePath = path.join(sessionDir, 'summaries.json');
    this.load();
  }

  getAll(): TurnSummary[] {
    return this.items;
  }

  get count(): number {
    return this.items.length;
  }

  /** 合并新摘要：去重（关键词重叠 > 70% 合并），限制 30 条 */
  merge(newTurns: TurnSummary[]): void {
    for (const inc of newTurns) {
      const incSet = new Set(inc.keywords.map(k => k.toLowerCase()));
      if (incSet.size === 0) { this.items.push(inc); continue; }
      const dupIdx = this.items.findIndex(e => {
        const eSet = new Set(e.keywords.map(k => k.toLowerCase()));
        if (eSet.size === 0) return false;
        const overlap = [...incSet].filter(k => eSet.has(k)).length;
        return overlap / Math.max(incSet.size, eSet.size) > 0.7;
      });
      if (dupIdx >= 0) {
        const existing = this.items[dupIdx];
        this.items[dupIdx] = {
          summary: inc.summary,
          keywords: [...new Set([...existing.keywords, ...inc.keywords])],
          indices: [...new Set([...existing.indices, ...inc.indices])].sort((a, b) => a - b),
        };
      } else {
        this.items.push(inc);
      }
    }
    this.items = this.items.slice(-30);
    this.save();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.items = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch {}
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.items, null, 2), 'utf-8');
    } catch {}
  }
}
