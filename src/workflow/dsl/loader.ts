/**
 * ## DSL 文件加载器 — YAML 文件 → WorkflowDefinition
 *
 * 替代现有的 src/workflow/loader.ts。
 * 对外暴露相同的 loadWorkflowFile / scanWorkflowsDir 签名，
 * 内部使用 DSL 解析 + 编译流程。
 *
 * 设计约束：
 *   - 签名完全兼容旧 loader.ts
 *   - 旧简单 YAML 自动升级为 DSL 格式
 *   - 所有解析/编译错误返回 null（不崩溃）
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowDefinition } from '../types.js';
import type { WorkflowRegistry } from '../registry.js';
import { parse } from './parser.js';
import { compileWorkflow } from './compiler.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('workflow:dsl:loader');

/**
 * 从 YAML 文件加载 WorkflowDefinition。
 * 返回 null 表示解析/编译失败。
 */
export function loadWorkflowFile(filePath: string): WorkflowDefinition | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseAndCompile(content);
  } catch (err) {
    logger.warn(`Failed to load workflow file: ${filePath}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 从 YAML 字符串编译 WorkflowDefinition。
 * 仅当调用方已有字符串内容（不读文件）时使用。
 */
export function parseAndCompile(yamlText: string): WorkflowDefinition | null {
  const result = parse(yamlText);
  if (result.errors.length > 0) {
    logger.warn('DSL parse errors', { errors: result.errors });
    return null;
  }
  if (!result.ir) return null;

  return compileWorkflow(result.ir);
}

/**
 * 扫描目录中的 YAML 文件并注册到 WorkflowRegistry。
 * 返回成功加载的工作流名称列表。
 */
export function scanWorkflowsDir(
  dir: string,
  registry: WorkflowRegistry,
): string[] {
  const loaded: string[] = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const filePath = path.join(dir, entry);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const def = loadWorkflowFile(filePath);
      if (!def) continue;

      // 内置名保护：不允许文件覆盖内置 Workflow
      if (registry.isBuiltin(def.name)) {
        logger.debug(`Skipping file workflow "${def.name}" — protected builtin name`);
        continue;
      }

      registry.register(def);
      loaded.push(def.name);
      logger.debug(`Loaded workflow from file: ${def.name}`);
    }
  } catch {
    // 目录不存在或不可读 → 忽略
  }
  return loaded;
}
