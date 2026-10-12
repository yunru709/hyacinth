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
   * 根据名称获取工具（仅在白名单中时返回）。
   *
   * **本地优先**（2026-10-08 修）：本 registry 自己 register 过的实例覆盖父同名工具。
   *
   * 为什么必须有这一层 —— 父 registry 里躺着的是**绑定父 loop 状态**的工具实例：
   * view_image / view_media 的闭包捕获了注册那一刻 loop 的 pendingImageInjections /
   * pendingMediaInjections / imageStore / getActiveProvider()。子 loop 构造时会注册
   * 绑定**自身**状态的同名工具（orchestrator/loop.ts「注册 view_image / view_media 工具」），
   * 但旧实现只读父 registry ⇒ 那些自建实例永远取不到 ⇒ 子 Agent 调 view_media 时
   * 图被推进**父 loop** 的队列：子 Agent 视觉静默失效（工具还返回"成功"），
   * 而图反过来污染主 Agent 的上下文。
   *
   * 同一条修复也救活了两个同族静默失效：delegate-tool 的 createSandboxedTool 包装
   * （原样 register 进本 registry）与 applyWorkspaceFence 的写类围栏 —— 它们都依赖
   * "register 进本 registry 后被 getAll/get 看见"这一契约。
   */
  override get(name: string): Tool | undefined {
    if (this.allowedTools.size > 0 && !this.allowedTools.has(name)) return undefined;
    return super.get(name) ?? this.parentRegistry.get(name);
  }

  /**
   * 获取所有允许的工具（本地优先：同名时本地实例胜出）。
   *
   * 白名单仍是唯一准入判据；合并后不产生重复名。
   */
  override getAll(): Tool[] {
    const merged = new Map<string, Tool>();
    for (const tool of this.parentRegistry.getAll()) {
      if (this.allowedTools.size > 0 && !this.allowedTools.has(tool.name)) continue;
      merged.set(tool.name, tool);
    }
    // 本地注册（子 loop 自建实例 / 沙箱包装 / 工作区围栏）覆盖父同名。
    // 白名单对本地实例**同样**生效 —— 否则子 loop 自建的工具会绕过 agentDef.allowedTools。
    for (const tool of super.getAll()) {
      if (this.allowedTools.size > 0 && !this.allowedTools.has(tool.name)) continue;
      merged.set(tool.name, tool);
    }
    return [...merged.values()];
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
    return super.has(name) || this.parentRegistry.has(name);
  }
}
