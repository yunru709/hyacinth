import type {
  Message,
  MessageContent,
  StreamEvent,
  ProviderType,
  ToolDefinition,
} from '../types.js';
import type { Provider, ProviderCapabilities } from '../provider/interface.js';
import { withRetry } from '../provider/retry.js';
import type { LlamaCppOptions } from './types.js';

export type { LlamaCppOptions };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** SSE chunk 的内部解析结构 */
interface SSEData {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** OpenAI 兼容格式的消息结构（普通 object，不依赖 openai SDK） */
interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  cache_control?: { type: 'ephemeral' };
}

interface OpenAIToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

// ---------------------------------------------------------------------------
// LlamaCppProvider
// ---------------------------------------------------------------------------

/**
 * LlamaCppProvider — 通过原生 fetch + SSE 调用 llama-server 的 OpenAI 兼容 API。
 *
 * 与 LocalProvider 的区别：
 *  - 不依赖 openai npm 包，使用原生 fetch
 *  - 提供健康检查（checkHealth）
 *  - 提供 Adapter（LoRA）管理
 *  - 暴露 getCapabilities()
 *  - ProviderType 为 'llamacpp'
 */
export class LlamaCppProvider implements Provider {
  private endpoint: string;
  private model: string;
  private maxTokens: number;
  private maxContextTokens: number;
  private loadedAdapters: Map<string, string> = new Map();

  constructor(opts: LlamaCppOptions = {}) {
    this.endpoint = opts.endpoint ?? 'http://127.0.0.1:8080';
    this.model = opts.model ?? 'llama-3-8b-q4_k_m';
    this.maxTokens = opts.maxTokens ?? 4096;
    this.maxContextTokens = opts.maxContextTokens ?? 8192;
  }

  // ---- Provider 元信息 ----

  getProviderType(): ProviderType {
    return 'llamacpp';
  }

  getModel(): string {
    return this.model;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolCalling: true,
      streaming: true,
      adapterSupport: true,
      maxContextTokens: this.maxContextTokens,
      isLocal: true,
      vision: false,
    };
  }

  // -----------------------------------------------------------------------
  // 健康检查
  // -----------------------------------------------------------------------

  /**
   * 检查 llama-server 是否正常运行。
   *
   * 发送 GET {endpoint}/health，解析响应中的 status / model 字段。
   * 构造函数中不自动调用，由调用方按需使用。
   *
   * @returns { ok: boolean, model?: string }
   */
  async checkHealth(): Promise<{ ok: boolean; model?: string }> {
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { ok: false };
      }
      const data = (await response.json()) as { status?: string; model?: string };
      return {
        ok: data.status === 'ok' || data.status === 'healthy' || response.status === 200,
        model: data.model,
      };
    } catch {
      return { ok: false };
    }
  }

  // -----------------------------------------------------------------------
  // Adapter 管理（llama-server 的 LoRA API）
  // -----------------------------------------------------------------------

  /**
   * 通过 llama-server 的 /v1/lora 端点动态加载 LoRA Adapter。
   *
   * @param name - Adapter 标识名称
   * @param path - Adapter 权重文件路径
   */
  async loadAdapter(name: string, path: string): Promise<void> {
    try {
      const response = await fetch(`${this.endpoint}/v1/lora`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Failed to load adapter: HTTP ${response.status}${body ? ` — ${body}` : ''}`);
      }
      this.loadedAdapters.set(name, path);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[LlamaCppProvider] Failed to load adapter '${name}': ${message}. ` +
          'Make sure llama-server supports the /v1/lora endpoint.',
      );
      throw error;
    }
  }

  /**
   * 卸载指定的 Adapter（从内部 Map 移除）。
   *
   * @param name - Adapter 名称
   */
  async unloadAdapter(name: string): Promise<void> {
    this.loadedAdapters.delete(name);
  }

  /**
   * 列出当前已加载的 Adapter 名称。
   */
  async listAdapters(): Promise<string[]> {
    return Array.from(this.loadedAdapters.keys());
  }

  // -----------------------------------------------------------------------
  // 流式对话 — createStream
  // -----------------------------------------------------------------------

  async *createStream(
    messages: Message[],
    tools?: ToolDefinition[],
  ): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.convertMessages(messages),
      max_tokens: this.maxTokens,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
    }

    const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

    // 发起请求（含重试）
    let response: Response;
    try {
      response = await withRetry(
        () =>
          fetch(`${this.endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        {},
        'llamacpp.fetch',
      );
    } catch (error: unknown) {
      throw new Error(
        `Cannot connect to llama.cpp server at ${this.endpoint}. ` +
          'Make sure llama-server is running.',
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `llama.cpp API error (HTTP ${response.status}): ${errorText || response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error('llama.cpp server returned an empty response body.');
    }

    // 消费 SSE 流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // 最后一段可能不完整，保留到下次拼接
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const dataStr = trimmed.slice(5).trimStart(); // 去掉 "data:" 及可能的空格
          if (dataStr === '[DONE]') continue;

          let data: SSEData;
          try {
            data = JSON.parse(dataStr);
          } catch {
            // 无效 JSON 行，跳过
            continue;
          }

          const choice = data.choices?.[0];
          if (!choice) {
            // usage 可能出现在没有 choices 的 chunk 中
            if (data.usage) {
              yield {
                type: 'USAGE',
                input_tokens: data.usage.prompt_tokens ?? 0,
                output_tokens: data.usage.completion_tokens ?? 0,
              };
            }
            continue;
          }

          const delta = choice.delta;

          // ---- usage（某些实现放在 choice 所在的 chunk 中） ----
          if (data.usage) {
            yield {
              type: 'USAGE',
              input_tokens: data.usage.prompt_tokens ?? 0,
              output_tokens: data.usage.completion_tokens ?? 0,
            };
          }

          // ---- reasoning_content（thinking 输出） ----
          if (delta?.reasoning_content) {
            yield { type: 'THINKING', content: delta.reasoning_content };
          }

          // ---- 文本内容 ----
          if (delta?.content) {
            yield { type: 'TEXT', content: delta.content };
          }

          // ---- tool_calls ----
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccumulators.has(idx)) {
                toolCallAccumulators.set(idx, {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  arguments: '',
                });
              }
              const acc = toolCallAccumulators.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }

          // ---- finish_reason → 输出累积完成的 tool call ----
          if (choice.finish_reason) {
            for (const [, acc] of toolCallAccumulators) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(acc.arguments || '{}');
              } catch {
                // JSON 解析失败时保留空对象
              }
              yield {
                type: 'TOOL_USE',
                id: acc.id,
                name: acc.name,
                input,
              };
            }
            toolCallAccumulators.clear();
            yield { type: 'STOP', reason: choice.finish_reason };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // -----------------------------------------------------------------------
  // 消息转换
  // -----------------------------------------------------------------------

  /**
   * 将内部 Message[] 转换为 OpenAI 兼容格式的普通对象数组。
   *
   * 转换规则：
   * - system / user 角色 → { role, content }（文本拼接）
   * - user 消息中的 tool_result → 独立的 { role: 'tool', tool_call_id, content } 消息
   * - assistant 角色 → { role: 'assistant', content, tool_calls }
   * - cache_control（ephemeral）保留在消息上
   */
  private convertMessages(
    messages: Message[],
  ): Array<OpenAIMessage | OpenAIToolMessage | Record<string, unknown>> {
    const result: Array<OpenAIMessage | OpenAIToolMessage | Record<string, unknown>> = [];

    for (const msg of messages) {
      const blocks: MessageContent[] = Array.isArray(msg.content) ? msg.content : [msg.content];

      if (msg.role === 'assistant') {
        const textParts: string[] = [];
        const toolCalls: OpenAIMessage['tool_calls'] = [];

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else {
        // system 或 user 角色
        const textParts: string[] = [];
        const toolResults: OpenAIToolMessage[] = [];
        let hasCacheControl = false;

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(block.text);
            if (block.cache_control?.type === 'ephemeral') {
              hasCacheControl = true;
            }
          } else if (block.type === 'tool_result') {
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }

        if (textParts.length > 0) {
          const userMsg: Record<string, unknown> = {
            role: msg.role,
            content: textParts.join(''),
          };
          if (hasCacheControl) {
            userMsg.cache_control = { type: 'ephemeral' };
          }
          result.push(userMsg);
        }
        result.push(...toolResults);
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // 工具定义转换
  // -----------------------------------------------------------------------

  /**
   * 将 ToolDefinition[] 转换为 OpenAI function calling 格式。
   *
   * { name, description, input_schema }
   *   → { type: 'function', function: { name, description, parameters: input_schema } }
   */
  private convertTools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// 便捷工厂函数
// ---------------------------------------------------------------------------

/**
 * 创建 LlamaCppProvider 实例。
 *
 * @param opts - 可选配置
 * @returns LlamaCppProvider
 *
 * @example
 * ```ts
 * const provider = createLlamaCppProvider({
 *   endpoint: 'http://127.0.0.1:8080',
 *   model: 'qwen2.5-7b-q4_k_m',
 * });
 *
 * const health = await provider.checkHealth();
 * if (!health.ok) throw new Error('llama-server not available');
 *
 * for await (const event of provider.createStream(messages)) {
 *   // handle event
 * }
 * ```
 */
export function createLlamaCppProvider(opts?: LlamaCppOptions): LlamaCppProvider {
  return new LlamaCppProvider(opts);
}