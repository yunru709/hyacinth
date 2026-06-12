import type { ToolRegistry } from '../tools/registry.js';
import type { MCPClient } from './client.js';
import type { MCPServerManager } from './lifecycle.js';
import { createLogger } from '../logging/logger.js';
import { hasSideEffect, sanitizeMcpName } from './side-effect.js';

// 保持向后兼容：lifecycle.ts 从此处导入 sanitizeMcpName
export { sanitizeMcpName };

/**
 * MCPBridge — 将 MCP Server 的工具桥接到内部 ToolRegistry
 *
 * 为每个 MCP 工具创建一个桥接执行函数，注册到 ToolRegistry 中。
 * 工具名称格式：mcp__{serverName}__{toolName}（避免命名冲突）
 */
export class MCPBridge {
  private registeredTools = new Map<string, string[]>();
  private logger = createLogger('mcp:bridge');

  constructor(
    private clients: MCPClient[],
    private managers: MCPServerManager[] = [],
  ) {}

  /** 设置 MCPServerManager 列表（用于按需拉起） */
  setManagers(managers: MCPServerManager[]): void {
    this.managers = managers;
  }

  /** 更新 clients/managers 列表（保留 registeredTools 历史） */
  updateClients(clients: MCPClient[], managers: MCPServerManager[]): void {
    this.clients = clients;
    this.managers = managers;
  }

  /** 获取指定名称的 MCPServerManager */
  getManager(name: string): MCPServerManager | undefined {
    return this.managers.find(m => m.getName() === name);
  }

  /** 将所有已连接 MCP Server 的工具注册到 ToolRegistry */
  registerToRegistry(registry: ToolRegistry): void {
    for (const client of this.clients) {
      if (!client.isConnected()) {
        this.logger.warn(`skipping disconnected MCP client: ${client.getName()}`);
        continue;
      }

      const serverName = client.getName();

      // 幂等性：如果该 server 已有旧注册记录，先清理
      const oldNames = this.registeredTools.get(serverName);
      if (oldNames) {
        for (const name of oldNames) {
          registry.unregister(name);
        }
      }

      const toolNames: string[] = [];

      for (const tool of client.getTools()) {
        const mcpToolName = `mcp__${sanitizeMcpName(serverName)}__${tool.name}`;
        toolNames.push(mcpToolName);
        registry.register({
          name: mcpToolName,
          description: `[MCP:${serverName}] ${tool.description ?? tool.name}${hasSideEffect(tool.name) ? ' [side-effect]' : ''}`,
          inputSchema: tool.inputSchema,
          execute: async (input: Record<string, unknown>) => {
            return client.callTool(tool.name, input);
          },
        });
      }

      this.registeredTools.set(serverName, toolNames);
    }
  }

  /** 注销指定 MCP Server 的所有已注册工具 */
  unregisterTools(serverName: string, registry: ToolRegistry): void {
    const toolNames = this.registeredTools.get(serverName);
    if (!toolNames) return;

    for (const name of toolNames) {
      registry.unregister(name);
    }
    this.registeredTools.delete(serverName);
  }

  /** 获取所有已连接 MCP Server 的合并索引 */
  getMergedIndex(): string {
    const parts: string[] = [];
    for (const client of this.clients) {
      if (!client.isConnected()) continue;
      const index = client.getToolIndex();
      if (index) parts.push(index);
    }
    return parts.join('\n\n');
  }

  /** 获取所有已连接 MCP Server 的工具名称列表 */
  getAllToolNames(): string[] {
    const names: string[] = [];
    for (const client of this.clients) {
      if (!client.isConnected()) continue;
      for (const tool of client.getTools()) {
        names.push(`mcp__${client.getName()}__${tool.name}`);
      }
    }
    return names;
  }
}
