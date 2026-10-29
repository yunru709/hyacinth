import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPConfig } from '../types.js';
import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';

function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {  let timer: ReturnType<typeof setTimeout>;
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
          .map((block: unknown) => this.formatContentBlock(block))
          .filter((s) => s.length > 0)
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

  /**
   * 把 MCP content block 序列化成注入对话历史的文本。
   *
   * ⚠️ 这里是 2026-10-29 上下文爆炸事故的根因点，改动前务必读完下面注释。
   *
   * 事故：windows-mcp 的 Snapshot/Screenshot 返回 `[{type:'text'}, {type:'image', data:<base64>, mimeType}]`。
   * 旧实现对非 text 块一律 `JSON.stringify(block)` ⇒ 一张 628KB 的 PNG 变成 78 万字符的纯文本
   * （base64 约 1.3~2 字符/token ⇒ 单条约 20 万 tokens）进历史，压缩时又被 compressor 复制一份
   * ⇒ 上下文 1.1M tokens > 模型 1M 窗口 ⇒ 上游只回 "400 Model is unavailable"（opencode 对
   * 「请求处理不了」的粗粒度报错，与模型下线共用同一句，极易误诊）。
   *
   * 现行策略（三条，缺一不可）：
   *  ① image 块：base64 **绝不内联**，落盘成临时文件后只注入路径指针，模型需要时用 read 自行查看；
   *  ② 落盘失败：退化为「已省略」占位，宁可丢图也绝不把 base64 塞进上下文；
   *  ③ 其他未知块：JSON 化但强制截断，杜绝任何协议扩展带来的第二起同类事故。
   */
  private formatContentBlock(block: unknown): string {
    if (!block || typeof block !== 'object') return String(block ?? '');

    const b = block as {
      type?: string;
      text?: string;
      data?: string;
      mimeType?: string;
      source?: { type?: string; media_type?: string; data?: string; url?: string };
    };

    if (b.type === 'text' && typeof b.text === 'string') return b.text;

    if (b.type === 'image') {
      const data = typeof b.data === 'string' ? b.data : b.source?.data;
      const mime = b.mimeType ?? b.source?.media_type ?? 'image/png';
      if (!data) return `[Image: ${mime} — no data]`;
      const bytes = Math.floor((data.length * 3) / 4);
      const filePath = this.persistImage(data, mime);
      return filePath
        ? `[Image saved: ${filePath} (${mime}, ${(bytes / 1024).toFixed(1)} KB) — use read(file_path="${filePath}") to view]`
        : `[Image omitted: ${mime}, ${(bytes / 1024).toFixed(1)} KB — could not persist, base64 dropped]`;
    }

    // 未知块类型（audio/resource/未来扩展）：JSON 化但强制截断
    let json: string;
    try {
      json = JSON.stringify(block);
    } catch {
      json = String(block);
    }
    if (json.length > MAX_INLINE_BLOCK_CHARS) {
      return `${json.slice(0, MAX_INLINE_BLOCK_CHARS)}… [block truncated, ${json.length} chars total]`;
    }
    return json;
  }

  /** 把图片 base64 落盘（同内容按 sha1 去重），返回绝对路径；失败返回 null。 */
  private persistImage(base64: string, mime: string): string | null {
    try {
      const ext = (mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
      const hash = createHash('sha1').update(base64).digest('hex').slice(0, 16);
      const dir = join(tmpdir(), 'hyacinth-mcp-images');
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${hash}.${ext}`);
      if (!existsSync(filePath)) writeFileSync(filePath, Buffer.from(base64, 'base64'));
      return filePath;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn('failed to persist MCP image', { error: msg });
      return null;
    }
  }

  /** 获取 Server 名称 */
  getName(): string {
    return this.config.name;
  }
}
