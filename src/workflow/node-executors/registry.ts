/**
 * Node Executor Registry — 节点执行器注册表
 *
 * 负责注册、查询节点执行器。遵循可插拔设计原则：
 * - register() 注册执行器
 * - get() 按节点类型查询
 * - getAll() 获取全部（用于调试/遍历）
 *
 * 默认实例 `defaultNodeExecutorRegistry` 在 index.ts 中创建并填充内置执行器。
 */

import type { NodeExecutor } from './types.js';

export class NodeExecutorRegistry {
  private executors = new Map<string, NodeExecutor>();

  /** 注册节点执行器（按节点类型） */
  register(type: string, executor: NodeExecutor): void {
    this.executors.set(type, executor);
  }

  /** 按节点类型获取执行器 */
  get(type: string): NodeExecutor | undefined {
    return this.executors.get(type);
  }

  /** 获取所有已注册执行器 */
  getAll(): Map<string, NodeExecutor> {
    return new Map(this.executors);
  }

  /** 检查是否已注册指定类型 */
  has(type: string): boolean {
    return this.executors.has(type);
  }

  /** 注销指定类型的执行器 */
  unregister(type: string): boolean {
    return this.executors.delete(type);
  }
}

/**
 * 默认节点执行器注册表实例。
 *
 * 在 index.ts 中由 registerDefaultExecutors() 填充内置执行器。
 * 用户可通过此实例注册自定义执行器或替换内置实现。
 */
export const defaultNodeExecutorRegistry = new NodeExecutorRegistry();
