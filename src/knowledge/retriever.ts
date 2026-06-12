/**
 * Retriever 接口 — 知识库检索后端抽象
 *
 * 将存储/检索操作与具体的检索引擎解耦。
 * 当前实现：Fts5Retriever（SQLite FTS5 + BM25）
 * 未来实现：VectorRetriever（本地 embedding）、HybridRetriever（混合）
 */

/** 知识库文档 */
export interface KbDocument {
  id: string;
  title: string;
  source: string;
  content: string;
  created_at?: string;
}

/** 检索结果 — 含匹配片段高亮 */
export interface KbSearchResult {
  title: string;
  source: string;
  snippet: string; // 匹配片段，FTS5 用 <b> 标签高亮
}

/** 检索后端接口 */
export interface Retriever {
  /** 后端名称，用于日志和诊断 */
  readonly name: string;

  /** 关键词检索，返回 Top K 结果 */
  search(query: string, k: number): KbSearchResult[];

  /** 添加文档，返回文档 ID */
  add(doc: KbDocument): string;

  /** 按 ID 删除文档 */
  remove(id: string): boolean;

  /** 更新文档（按 ID）。仅更新传入的字段 */
  update(id: string, fields: Partial<Pick<KbDocument, 'title' | 'content' | 'source'>>): boolean;

  /** 按 source 路径查找文档 ID（用于文件变更时的去重更新） */
  findBySource(source: string): { id: string } | undefined;

  /** 列出所有文档 */
  list(): KbDocument[];

  /** 文档总数 */
  count(): number;

  /** 关闭并释放资源 */
  close(): void;
}
