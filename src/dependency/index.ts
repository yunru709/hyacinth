export { DependencyAnalyzer } from './analyzer.js';
export { DependencyParser } from './parser.js';
export { FunctionParser } from './function-parser.js';
export { DataFlowTracker } from './data-flow-tracker.js';
export type { DependencyGraph, FileDependency, ImpactResult, SerializedDependencyGraph } from './types.js';
export type { FunctionDef, CallSite } from './function-parser.js';
export type { DataFlowPoint } from './data-flow-tracker.js';

import { DependencyAnalyzer } from './analyzer.js';

/**
 * 初始化依赖图谱分析器（共享函数，供 CLI/TUI 调用）
 * 优先加载缓存，缓存无效时全量构建
 */
export async function initDependencyAnalyzer(rootDir: string): Promise<DependencyAnalyzer | undefined> {
  try {
    const analyzer = new DependencyAnalyzer();
    await analyzer.analyze(rootDir);
    return analyzer;
  } catch {
    return undefined;
  }
}
