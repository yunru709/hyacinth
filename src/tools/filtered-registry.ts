import type { ToolDefinition } from '../types.js';
import type { Tool } from './interface.js';
import { ToolRegistry } from './registry.js';

/**
 * FilteredToolRegistry — 包装 ToolRegistry，基于白名单过滤工具
 * 用于子 Agent 的工具隔离：子 Agent 只能使用白名单中的工具
 */
export class FilteredToolRegistry extends ToolRegistry {
  private parentRegistry: ToolRegistry;
  private allowedTools: Set<string>;

  constructor(parentRegistry: ToolRegistry, allowedTools: string[]) {
    super(); // 父类的 Map 为空，我们不使用它
    this.parentRegistry = parentRegistry;
    this.allowedTools = new Set(allowedTools);
  }

  /**
   * 根据名称获取工具（仅在白名单中时返回）
   */
  override get(name: string): Tool | undefined {
    if (this.allowedTools.size > 0 && !this.allowedTools.has(name)) return undefined;
    return this.parentRegistry.get(name);
  }

  /**
   * 获取所有允许的工具
   */
  override getAll(): Tool[] {
    const all = this.parentRegistry.getAll();
    if (this.allowedTools.size === 0) return all;
    return all.filter(t => this.allowedTools.has(t.name));
  }

  /**
   * 生成 LLM 格式的工具定义数组（仅包含白名单中的工具）
   */
  override getToolDefinitions(): ToolDefinition[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /**
   * 检查指定名称的工具是否可用
   */
  override has(name: string): boolean {
    if (this.allowedTools.size > 0 && !this.allowedTools.has(name)) return false;
    return this.parentRegistry.has(name);
  }
}
