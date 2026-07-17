/**
 * 交叉引用工具集 — 统一导出入口。
 *
 * 三个工具：
 *   xref_build — 构建索引
 *   xref_query — 查询索引
 *   xref_graph — 可视化
 *
 * 共享 XrefManager 实例（由 factory.ts 创建并注入到三个工具）。
 *
 * 架构：
 *   factory.ts → new XrefManager() → manager.init(rootDir)
 *              → new XrefBuildTool(manager)
 *              → new XrefQueryTool(manager)
 *              → new XrefGraphTool(manager)
 *              → toolRegistry.register(...)
 *
 * 数据库：~/.agent/cache/xref-<projectKey>.sqlite (better-sqlite3)
 * 解析器：TypeScript Compiler API + 正则回退
 */

export { XrefManager } from './manager.js';
export { XrefBuildTool } from './xref-build.js';
export { XrefQueryTool } from './xref-query.js';
export { XrefGraphTool } from './xref-graph.js';
