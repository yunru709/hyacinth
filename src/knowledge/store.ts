/**
 * KnowledgeBase — 知识库状态管理器
 *
 * 管理启用状态（/kb on/off、/zone4 on/off）并将存储/检索委托给 Retriever。
 * 默认使用 Fts5Retriever（SQLite FTS5），未来可切换到向量/混合检索。
 */

import type { Retriever, KbDocument, KbSearchResult } from './retriever.js';
import { Fts5Retriever } from './fts5-retriever.js';

// 保持旧类型导出兼容
export type { KbDocument as KbDoc, KbSearchResult as KbResult } from './retriever.js';

export class KnowledgeBase {
  private _retriever: Retriever | null = null;
  private _dbPath: string | undefined;
  private _enabled = false;
  private _zone4Enabled = true; // Zone 4 默认开启

  constructor(dbPathOrRetriever: string | Retriever) {
    if (typeof dbPathOrRetriever === 'string') {
      this._dbPath = dbPathOrRetriever;
    } else {
      this._retriever = dbPathOrRetriever;
    }
  }

  /** 懒加载 retriever，仅在首次访问时创建 Fts5Retriever */
  get retriever(): Retriever {
    if (!this._retriever) {
      this._retriever = new Fts5Retriever(this._dbPath!);
    }
    return this._retriever;
  }

  // ── 状态管理 ──────────────────────────────────────────────────────

  get enabled(): boolean {
    return this._enabled && this._zone4Enabled;
  }
  enable(): void {
    this._enabled = true;
  }
  disable(): void {
    this._enabled = false;
  }
  setZone4Enabled(v: boolean): void {
    this._zone4Enabled = v;
    if (!v) this._enabled = false;
  }
  get zone4Enabled(): boolean {
    return this._zone4Enabled;
  }

  // ── 存储/检索委托 ─────────────────────────────────────────────────

  search(query: string, k: number = 5): KbSearchResult[] {
    return this.retriever.search(query, k);
  }

  add(title: string, content: string, source: string = ''): string {
    return this.retriever.add({ id: '', title, content, source });
  }

  remove(id: string): boolean {
    return this.retriever.remove(id);
  }

  update(
    id: string,
    fields: Partial<Pick<KbDocument, 'title' | 'content' | 'source'>>,
  ): boolean {
    return this.retriever.update(id, fields);
  }

  list(): KbDocument[] {
    return this.retriever.list();
  }

  count(): number {
    return this.retriever.count();
  }

  close(): void {
    this.retriever.close();
  }
}
