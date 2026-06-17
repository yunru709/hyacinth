/**
 * ## Workflow 文件加载器 — 委托到 DSL 引擎
 *
 * 所有 YAML 加载逻辑已迁移到 dsl/loader.ts。
 * 此文件保留为兼容性委托层，对外签名不变。
 *
 * 支持两种格式：
 *   1. 完整 DSL 格式（phases/render/complete 等）
 *   2. 旧简单格式（name/description/steps）——自动升级为 DSL
 */
import type { WorkflowDefinition } from './types.js';
import type { WorkflowRegistry } from './registry.js';
import {
  loadWorkflowFile as dslLoad,
  scanWorkflowsDir as dslScan,
} from './dsl/loader.js';

/**
 * 从 .yaml 文件加载一个 workflow 定义。
 * 返回 null 表示解析/编译失败。
 */
export function loadWorkflowFile(filePath: string): WorkflowDefinition | null {
  return dslLoad(filePath);
}

/**
 * 扫描目录中的 .yaml workflow 文件并注册它们。
 * 返回成功加载的 workflow 名称列表。
 */
export function scanWorkflowsDir(
  dir: string,
  registry: WorkflowRegistry,
): string[] {
  return dslScan(dir, registry);
}
