/**
 * Node Executors — 节点执行器模块入口
 *
 * 导出所有类型、注册表和内置执行器。
 * 在模块加载时将内置执行器注册到 defaultNodeExecutorRegistry。
 *
 * 可插拔设计：
 *   - 用户可通过 defaultNodeExecutorRegistry.register(type, executor) 替换内置执行器
 *   - 用户可注册自定义节点类型的执行器
 *   - 所有执行器实现 NodeExecutor 接口，接口稳定可替换
 */

// ── 类型导出 ──────────────────────────────────────────────────────────
export type {
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
} from './types.js';

// ── 注册表导出 ────────────────────────────────────────────────────────
export { NodeExecutorRegistry, defaultNodeExecutorRegistry } from './registry.js';

// ── 内置执行器导出 ────────────────────────────────────────────────────
export { startNodeExecutor } from './start.js';
export { endNodeExecutor } from './end.js';
export { noteNodeExecutor } from './note.js';
export { promptNodeExecutor } from './prompt.js';
export { contextNodeExecutor } from './context.js';
export { agentNodeExecutor } from './agent.js';
export { toolNodeExecutor } from './tool.js';
export { branchNodeExecutor } from './branch.js';
export { subworkflowNodeExecutor } from './subworkflow.js';

// ── 注册内置执行器到默认注册表 ────────────────────────────────────────
import { defaultNodeExecutorRegistry } from './registry.js';
import { startNodeExecutor } from './start.js';
import { endNodeExecutor } from './end.js';
import { noteNodeExecutor } from './note.js';
import { promptNodeExecutor } from './prompt.js';
import { contextNodeExecutor } from './context.js';
import { agentNodeExecutor } from './agent.js';
import { toolNodeExecutor } from './tool.js';
import { branchNodeExecutor } from './branch.js';
import { subworkflowNodeExecutor } from './subworkflow.js';

/**
 * 将所有内置节点执行器注册到指定注册表。
 * 可用于创建独立的注册表实例（如测试场景）。
 */
export function registerDefaultExecutors(
  registry: { register: (type: string, executor: import('./types.js').NodeExecutor) => void } = defaultNodeExecutorRegistry,
): void {
  registry.register('start', startNodeExecutor);
  registry.register('end', endNodeExecutor);
  registry.register('note', noteNodeExecutor);
  registry.register('prompt', promptNodeExecutor);
  registry.register('context', contextNodeExecutor);
  registry.register('agent', agentNodeExecutor);
  registry.register('tool', toolNodeExecutor);
  registry.register('branch', branchNodeExecutor);
  registry.register('subworkflow', subworkflowNodeExecutor);
}

// 模块加载时自动注册内置执行器
registerDefaultExecutors(defaultNodeExecutorRegistry);
