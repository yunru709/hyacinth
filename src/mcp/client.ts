import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPConfig } from '../types.js';
import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';

function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorMsg)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** MCP 工具信息（从 MCP Server 获取） */
export interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * MCPClient — 连接 MCP Server，获取工具列表，执行工具调用
 *
 * 支持 stdio 传输（子进程）和 HTTP SSE 传输
 */
export class MCPClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private connected = false;
  private tools: MCPToolInfo[] = [];
  private logger: Logger;

  constructor(private config: MCPConfig) {
    this.logger = createLogger(`mcp:client:${config.name}`);
  }

  /** 连接到 MCP Server */
  async connect(externalTransport?: Transport): Promise<void> {
    try {
      if (externalTransport) {
        this.transport = externalTransport;
      } else if (this.config.command) {
        // stdio 传输
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env
            ? ({ ...this.config.env } as Record<string, string>)
            : ({} as Record<string, string>),
        });
      } else if (this.config.url) {
        // HTTP SSE 传输
        const requestInit: RequestInit = {};
        if (this.config.headers) {
          requestInit.headers = this.config.headers;
        }
        this.transport = new SSEClientTransport(new URL(this.config.url), { requestInit });
      } else {
        this.logger.warn('no command or url configured, skipping');
        return;
      }

      if (!this.transport) {
        this.logger.warn('transport is not initialized, skipping');
        return;
      }

      this.client = new Client(
        {
          name: `agent-mcp-${this.config.name}`,
          version: '1.0.0',
        },
        {
          capabilities: {},
        },
      );
      await withTimeout(
        this.client.connect(this.transport),
        this.config.connectTimeout ?? 30_000,
        'MCP connect timed out (30s)',
      );

      // 获取工具列表
      const result = await this.client.listTools();
      this.tools = (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
      this.connected = true;
      this.logger.info('connected', { tools: this.tools.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn('connection failed', { error: msg });
      this.connected = false;
      // 必须向上抛出，否则 MCPServerManager 会误认为连接成功
      throw error;
    }
  }

  /** 断开连接 */
  async disconnect(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // SSE transport 可能抛出错误，忽略
      }
      this.transport = null;
    }
    this.client = null;
    this.connected = false;
    this.tools = [];
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.connected;
  }

  /** 获取 MCP Server 提供的工具列表 */
  getTools(): MCPToolInfo[] {
    return this.tools;
  }

  /** 获取工具索引（名称+描述列表） */
  getToolIndex(): string {
    if (this.tools.length === 0) return '';
    return (
      `MCP Server [${this.config.name}]:\n` +
      this.tools
        .map((t) => `- ${t.name}: ${t.description ?? '(no description)'}`)
        .join('\n')
    );
  }

  /** 调用 MCP 工具 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.client || !this.connected) {
      return `Error: MCP Server "${this.config.name}" is not connected`;
    }

    try {
      const result = await withTimeout(
        this.client.callTool({ name, arguments: args }),
        this.config.callTimeout ?? 60_000,
        `MCP tool call timed out (60s): ${name}`,
      );
      // 将结果转换为字符串
      if (typeof result.content === 'string') {
        return result.content;
      }
      if (Array.isArray(result.content)) {
        return result.content
          .map((block: { type: string; text?: string }) => {
            if (block.type === 'text' && block.text) return block.text;
            return JSON.stringify(block);
          })
          .join('\n');
      }
      return JSON.stringify(result.content);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        return error.message;
      }
      const msg = error instanceof Error ? error.message : String(error);
      const lowerMsg = msg.toLowerCase();
      if (lowerMsg.includes('not connected') || lowerMsg.includes('connection') || lowerMsg.includes('closed')) {
        return `MCP Server '${this.config.name}' connection lost. The server may have crashed.`;
      }
      if (lowerMsg.includes('invalid') || lowerMsg.includes('schema') || lowerMsg.includes('parameter')) {
        return `MCP tool '${name}' parameter error: ${msg}`;
      }
      return `MCP tool '${name}' internal error: ${msg}`;
    }
  }

  /** 获取 Server 名称 */
  getName(): string {
    return this.config.name;
  }
}
