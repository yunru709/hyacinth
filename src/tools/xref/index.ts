/**
 * 交叉引用工具集 — 统一导出入口。
 *
 * 四个工具：
 *   xref_build — 构建索引
 *   xref_query — 查询索引
 *   xref_graph — 可视化
 *   xref_list  — 列出/清理各项目的索引库
 *
 * 共享 XrefManager 实例（由 xref-plugin 创建并注入到各工具）。
 *
 * 架构：
 *   xref-plugin.activate()
 *              → new XrefManager() →（尝试）manager.init(启动目录)
 *              → new XrefBuildTool / XrefQueryTool / XrefGraphTool / XrefListTool
 *              → ctx.registerTool(...)
 *   注：init 失败**不再**导致工具缺席 —— 根可由 xref_build 的 root 参数显式指定。
 *
 * 数据库：~/.agent/cache/xref-<projectKey>.sqlite (node:sqlite)
 * 解析器：TypeScript Compiler API + 正则回退
 */

export { XrefManager } from './manager.js';
export { XrefBuildTool } from './xref-build.js';
export { XrefQueryTool } from './xref-query.js';
export { XrefGraphTool } from './xref-graph.js';
export { XrefListTool } from './xref-list.js';
