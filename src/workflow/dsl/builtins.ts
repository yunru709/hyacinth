/**
 * ## 内置工作流 YAML 路径解析
 *
 * 在开发模式下读取 src/workflow/builtin/*.workflow.yaml，
 * 在发行版中读取 dist/workflow/builtin/*.workflow.yaml。
 *
 * 设计约束：
 *   - 内置工作流以 YAML 文件形式发布（与用户自定义路径一致）
 *   - 文件路径基于 __dirname 解析，兼容 dev 和 dist 环境
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('workflow:dsl:builtins');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 内置工作流名称列表 */
export const BUILTIN_WORKFLOW_NAMES = ['bootstrap', 'plan', 'spec', 'todo'] as const;
export type BuiltinWorkflowName = (typeof BUILTIN_WORKFLOW_NAMES)[number];

/**
 * 获取内置工作流的 YAML 文件路径。
 *
 * 查找顺序：
 *   1. dist/workflow/builtin/<name>.workflow.yaml（发行版）
 *   2. src/workflow/builtin/<name>.workflow.yaml（开发模式）
 */
export function getBuiltinYamlPath(name: BuiltinWorkflowName | string): string {
  // dist 环境：dsl/ 目录的同级是 dist/workflow/
  const distDir = path.resolve(__dirname, '..', 'builtin');
  const distPath = path.join(distDir, `${name}.workflow.yaml`);
  if (fs.existsSync(distPath)) return distPath;

  // src/dev 环境：__dirname = dist/workflow/dsl/ → 上3级到项目根 → src/workflow/builtin/
  const srcDir = path.resolve(__dirname, '..', '..', '..', 'src', 'workflow', 'builtin');
  const srcPath = path.join(srcDir, `${name}.workflow.yaml`);
  if (fs.existsSync(srcPath)) return srcPath;

  logger.warn(`Builtin YAML not found for: ${name}`);
  return distPath; // 返回默认路径（调用方自行处理不存在）
}

/**
 * 检查内置工作流 YAML 文件是否存在。
 */
export function hasBuiltinYaml(name: BuiltinWorkflowName | string): boolean {
  const p = getBuiltinYamlPath(name);
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
