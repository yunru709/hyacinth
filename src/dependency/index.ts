export { DependencyAnalyzer } from './analyzer.js';
export { DependencyParser } from './parser.js';
export { FunctionParser } from './function-parser.js';
export { DataFlowTracker } from './data-flow-tracker.js';
export type { DependencyGraph, FileDependency, ImpactResult, SerializedDependencyGraph } from './types.js';
export type { FunctionDef, CallSite } from './function-parser.js';
export type { DataFlowPoint } from './data-flow-tracker.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DependencyAnalyzer } from './analyzer.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('dependency');

/**
 * 从 startDir 向上查找**项目根**（与 `tools/reference-analysis.ts` 的
 * findProjectRoot 同源的规则）：
 *   · 先找 `.git`（仓库根最准），再找 `package.json`（非 git 的 Node 项目）；
 *   · 向上**不越过 home 与盘根**（边界本身不算项目根）；
 *   · 到边界仍未命中 ⇒ 返回 null ⇒ 调用方跳过依赖分析。
 *
 * 为什么必须上溯：`process.cwd()` 只是启动目录，不一定是项目根。用户可能在
 * 仓库子目录（如 `src/gateway`）里跑 `hyacinth tui`，那时 cwd 没有 package.json，
 * 但项目根在上层。反过来，用户在 `C:\Users\74689\Desktop` 这种"容器目录"跑时，
 * 上溯到 home 边界都找不到标记 ⇒ 正确地跳过（而不是把整个桌面树当项目扫）。
 */
function resolveProjectRoot(startDir: string): string | null {
  const norm = (p: string): string =>
    (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)).replace(
      /[\\/]+$/,
      '',
    );
  const home = norm(os.homedir());
  const driveRoot = norm(path.parse(path.resolve(startDir)).root);
  const atBoundary = (n: string): boolean => n === home || n === driveRoot;

  const walkUp = (markers: readonly string[]): string | null => {
    let current = path.resolve(startDir);
    while (true) {
      if (atBoundary(norm(current))) return null;
      if (markers.some((m) => fs.existsSync(path.join(current, m)))) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };

  return walkUp(['.git']) ?? walkUp(['package.json']);
}

/**
 * 初始化依赖图谱分析器（共享函数，供 CLI/TUI 调用）
 * 优先加载缓存，缓存无效时全量构建。
 *
 * ⚠️ 2026-11-05 启动阻塞事故（52.8s，孑遗报「按下回车到 UI 加载完成接近 1min」）：
 *   在 `C:\Users\74689\Desktop` 下执行 `hyacinth tui`（cwd=Desktop），旧实现直接把
 *   `process.cwd()` 当项目根 ⇒ 依赖分析器把**整个桌面目录树**（41031 个 .ts/.js，
 *   含 Agent 下所有项目）当项目根，逐文件 readFile + 计算 MD5 全量重建，启动被拖
 *   到 52.8 秒（实测 analyze(Desktop)=75078ms；仓库根只需 ~1.2s / 903 文件）。
 *   webui 没事是因为桌面壳 WorkingDir 固定在仓库根 —— 这正是「webui 不卡、tui 卡」
 *   的根因。
 *
 *   修复：**先上溯解析真正的项目根**，再分析。Desktop 上溯不到标记 ⇒ 直接跳过，
 *   下游（AgentLoop/DelegateTool 的 dependencyAnalyzer 都是 optional）自动降级，
 *   **不影响启动、不影响主对话**。附带收益：从仓库任意子目录启动都归一到同一
 *   项目根，缓存 key 一致 ⇒ 与 webui 不再互相挤掉对方的依赖图缓存。
 *   另有护栏②（analyzer.fullBuild 的文件数上限）兜底超大单仓库。
 */
export async function initDependencyAnalyzer(startDir: string): Promise<DependencyAnalyzer | undefined> {
  const rootDir = resolveProjectRoot(startDir);
  if (!rootDir) {
    logger.warn('skip dependency analysis: no project root (.git/package.json) within bounds', {
      startDir,
    });
    return undefined;
  }
  try {
    const analyzer = new DependencyAnalyzer();
    await analyzer.analyze(rootDir);
    return analyzer;
  } catch (err) {
    logger.warn('dependency analysis failed', { rootDir, err: (err as Error).message });
    return undefined;
  }
}
