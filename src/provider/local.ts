import OpenAI from 'openai';
import type {
  Message,
  StreamEvent,
  ProviderType,
  ToolDefinition,
} from '../types.js';
import type { Provider, ProviderCapabilities } from './interface.js';
import { getLocalProviderConfigLoader } from './local-config.js';
import { recoverToolArguments, logToolArgsWarning } from './tool-args-recovery.js';

/** LocalProvider 构造选项 */
export interface LocalProviderOptions {
  baseUrl?: string;
  model?: string;
  /** 单次请求最大输出 token 数。兼容旧键名 maxTokens。 */
  maxOutputTokens?: number;
  /** @deprecated 使用 maxOutputTokens */
  maxTokens?: number;
  /** 后端类型：ollama | llamacpp。未指定时从 baseUrl 端口自动推断 */
  backend?: 'ollama' | 'llamacpp';
}

/**
 * Local Provider — 通过 OpenAI 兼容协议调用本地推理服务。
 *
 * 主要针对 llama.cpp server 设计，也兼容任何 OpenAI 兼容端点
 * （Ollama / vLLM / LM Studio 等）。
 *
 * 与 OpenAIProvider 的区别：
 *  - 不需要 API key
 *  - 默认地址指向 localhost
 *  - 对连接失败和服务错误做更宽松的处理
 */
export class LocalProvider implements Provider {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private _providerType: ProviderType;

  constructor(opts: LocalProviderOptions = {}) {
    const cfg = getLocalProviderConfigLoader();
    const baseUrl = opts.baseUrl ?? process.env.LOCAL_BASE_URL ?? cfg.baseUrl;
    this.client = new OpenAI({ apiKey: 'local', baseURL: baseUrl });
    this.model = opts.model ?? process.env.LOCAL_MODEL ?? cfg.defaultModel;
    this.maxTokens = opts.maxOutputTokens ?? opts.maxTokens ?? cfg.maxOutputTokens ?? cfg.maxTokens ?? 4096;
    // 推断后端类型
    const backend = opts.backend ?? (baseUrl.includes(':11434') ? 'ollama' : 'llamacpp');
    this._providerType = backend === 'ollama' ? 'ollama' as ProviderType : 'llamacpp' as ProviderType;
  }

  getProviderType(): ProviderType {
    return this._providerType;
  }

  getModel(): string {
    return this.model;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolCalling: true,
      streaming: true,
      adapterSupport: false,
      maxContextTokens: this.maxTokens,
      isLocal: true,
      vision: true, // Ollama/llama.cpp 均可加载视觉模型，默认开启
    };
  }

  setModel(model: string): void {
    this.model = model;
  }

  setBaseUrl(url: string): void {
    this.client = new OpenAI({
      apiKey: 'local',
      baseURL: url,
    });
  }

  async *createStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: this.convertMessages(messages),
      max_tokens: this.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      params.tools = this.convertTools(tools);
    }

    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      const stream = await this.client.chat.completions.create(params, { signal });

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        // usage — 部分本地推理服务不输出，可选
        if (chunk.usage) {
          yield {
            type: 'USAGE',
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
            cache_hit_tokens: (chunk.usage as unknown as Record<string, unknown>).prompt_cache_hit_tokens as number | undefined,
            cache_miss_tokens: (chunk.usage as unknown as Record<string, unknown>).prompt_cache_miss_tokens as number | undefined,
          };
        }

        if (!choice) continue;

        const delta = choice.delta;

        // reasoning_content（部分模型导出 thinking）
        if (
          'reasoning_content' in delta &&
          typeof (delta as any).reasoning_content === 'string'
        ) {
          yield { type: 'THINKING', content: (delta as any).reasoning_content as string };
        }

        // 文本内容
        if (delta.content) {
          yield { type: 'TEXT', content: delta.content };
        }

        // tool calls
        if (delta.tool_calls) {
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

        // finish_reason
        if (choice.finish_reason) {
          for (const [, acc] of toolCallAccumulators) {
            const raw = acc.arguments || '';
            const { recovered, complete, error } = recoverToolArguments(raw, acc.name);
            if (!complete) {
              logToolArgsWarning('local', acc.name, raw, error);
            }
            yield {
              type: 'TOOL_USE',
              id: acc.id,
              name: acc.name,
              input: recovered,
            };
          }
          toolCallAccumulators.clear();
          yield { type: 'STOP', reason: choice.finish_reason };
        }
      }
    } catch (error: unknown) {
      if (error instanceof OpenAI.APIError) {
        // 连接失败（status=undefined）给友好提示
        if (error.status === undefined) {
          throw new Error(
            `Cannot connect to local model at ${this.client.baseURL}. ` +
            'Make sure Ollama / llama.cpp (or another OpenAI-compatible local server) is running.',
          );
        }
        throw new Error(`Local model API error (${error.status}): ${error.message}`);
      }
      if (error instanceof Error) {
        throw new Error(`Local model stream error: ${error.message}`);
      }
      throw error;
    }
  }

  // ---- 转换方法 ----

  private convertMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    for (const msg of messages) {
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];

      if (msg.role === 'assistant') {
        const textParts: string[] = [];
        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

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

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else {
        const textParts: string[] = [];
        const toolResults: OpenAI.ChatCompletionToolMessageParam[] = [];
        const imageParts: OpenAI.ChatCompletionContentPartImage[] = [];

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          } else if (block.type === 'image') {
            // 仅视觉模型发送图片。LocalProvider 默认为非视觉，视图片为文本占位
            if (this.getCapabilities().vision) {
              const url = block.source.type === 'base64'
                ? `data:${block.source.media_type};base64,${block.source.data}`
                : block.source.url;
              imageParts.push({ type: 'image_url', image_url: { url } });
            } else {
              textParts.push(`[Image: ${block.source.type === 'base64' ? block.source.media_type : 'url'}]`);
            }
          }
        }

        result.push(...toolResults);
        if (imageParts.length > 0) {
          const content: OpenAI.ChatCompletionContentPart[] = [
            ...imageParts,
            ...(textParts.length > 0 ? [{ type: 'text' as const, text: textParts.join('') }] : []),
          ];
          if (msg.role === 'system') {
            result.push({ role: 'system', content: textParts.join('') });
          } else {
            result.push({ role: 'user', content });
          }
        } else if (textParts.length > 0) {
          if (msg.role === 'system') {
            result.push({ role: 'system', content: textParts.join('') });
          } else {
            result.push({ role: 'user', content: textParts.join('') });
          }
        }
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
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

/** 便捷工厂 */
export function createLocalProvider(config: { baseUrl?: string; model?: string } = {}): LocalProvider {
  return new LocalProvider(config);
}