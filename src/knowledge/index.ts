// Retriever 接口 + 类型
export type { Retriever, KbDocument, KbSearchResult } from './retriever.js';

// FTS5 实现
export { Fts5Retriever } from './fts5-retriever.js';

// 状态管理器（公开 API）
export { KnowledgeBase, type KbDoc, type KbResult } from './store.js';

// 索引器
export { indexFile, indexDirectory, removeFile, updateFile, syncDirectory } from './indexer.js';
export type { IndexOptions } from './indexer.js';

// 文件监控
export { KnowledgeWatcher } from './watcher.js';
export type { WatcherOptions } from './watcher.js';

// 工具
export { createKbAddTool, createKbListTool, createKbDeleteTool, createKbUpdateTool, createKbToggleTool } from './tools.js';

// 结构化知识库
export { StructuredStore, type StructuredEntry, type TagMatchResult, type EntryCategory } from './structured-store.js';
export { createAddStructuredTool, createUpdateStructuredTool, createDeleteStructuredTool, createListStructuredTool } from './structured-tools.js';
