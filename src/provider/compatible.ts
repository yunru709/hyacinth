import OpenAI from 'openai';
import type {
  Message,
  StreamEvent,
  ProviderType,
  ToolDefinition,
  MessageContent,
  ThinkingContent,
} from '../types.js';
import type { Provider, ProviderCapabilities } from './interface.js';
import { getModelInfo } from './catalog.js';
import { getProviderConfigLoader } from './config.js';

/** OpenAICompatibleProvider 构造选项 */
export interface OpenAICompatibleOptions {
  /** API key */
  apiKey?: string;
  /** 环境变量名（用于自动读取） */
  envKey?: string;
  /** API 基础 URL */
  baseUrl: string;
  /** 环境变量中的 base URL 覆盖 */
  baseUrlEnv?: string;
  /** 默认模型 */
  model: string;
  /** Provider 类型标识 */
  providerType: ProviderType;
  /** 最大输出 token */
  maxTokens?: number;
  /** 额外的 HTTP 头（如 OpenRouter 要求的 HTTP-Referer / X-Title） */
  headers?: Record<string, string>;
}

/**
 * OpenAICompatibleProvider — 通用 OpenAI 兼容 API Provider。
 *
 * 用一个类覆盖所有使用 OpenAI Chat Completions 格式的 Provider：
 *   - Groq (api.groq.com)
 *   - xAI / Grok (api.x.ai)
 *   - Mistral (api.mistral.ai)
 *   - OpenRouter (openrouter.ai)
 *   - Moonshot / Kimi (api.moonshot.cn)
 *
 * 用法：通过工厂函数设置各自的默认值。
 */
/** DeepSeek 思考强度选项 */
export type DeepSeekReasoningEffort = 'high' | 'max';

export class OpenAICompatibleProvider implements Provider {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private providerType: ProviderType;
  private thinkingEnabled = false;
  private reasoningEffort: DeepSeekReasoningEffort = 'high';

  constructor(opts: OpenAICompatibleOptions) {
    const apiKey = opts.apiKey ?? (opts.envKey ? process.env[opts.envKey] : undefined);
    if (!apiKey) {
      throw new Error(
        `${opts.providerType} API key is required. Set ${opts.envKey ?? 'API_KEY'} environment variable or pass apiKey.`,
      );
    }

    const baseURL = opts.baseUrlEnv
      ? (process.env[opts.baseUrlEnv] ?? opts.baseUrl)
      : opts.baseUrl;

    this.client = new OpenAI({
      apiKey,
      baseURL,
      ...(opts.headers ? { defaultHeaders: opts.headers } : {}),
    });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? getModelInfo(opts.providerType, opts.model)?.maxTokens ?? 4096;
    this.providerType = opts.providerType;
  }

  getProviderType(): ProviderType {
    return this.providerType;
  }

  getModel(): string {
    return this.model;
  }

  getCapabilities(): ProviderCapabilities {
    const info = getModelInfo(this.providerType, this.model);
    return {
      toolCalling: true,
      streaming: true,
      adapterSupport: false,
      maxContextTokens: info?.contextWindow ?? 128000,
      isLocal: false,
      vision: info?.capabilities.vision ?? false,
    };
  }

  setModel(model: string): void {
    this.model = model;
  }

  setThinking(enabled: boolean, effort?: DeepSeekReasoningEffort): void {
    this.thinkingEnabled = enabled;
    if (effort) this.reasoningEffort = effort;
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

    // 始终发送 thinking 参数：DeepSeek V4 默认 thinking=enabled，不发送会被当作 enabled
    (params as unknown as Record<string, unknown>).thinking = this.thinkingEnabled
      ? { type: 'enabled' }
      : { type: 'disabled' };
    if (this.thinkingEnabled) {
      (params as unknown as Record<string, unknown>).reasoning_effort = this.reasoningEffort;
    }

    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      const stream = await this.client.chat.completions.create(params, { signal });

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        // usage
        if (chunk.usage) {
          yield {
            type: 'USAGE',
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
            cache_hit_tokens: (chunk.usage as unknown as Record<string, unknown>).prompt_cache_hit_tokens as number | undefined,
            cache_miss_tokens: (chunk.usage as unknown as Record<string, unknown>).prompt_cache_miss_tokens as number | undefined,
          };
        }

        if (!choice) continue;

        const delta = choice.delta;

        // reasoning_content (thinking)
        if (
          'reasoning_content' in delta &&
          typeof (delta as any).reasoning_content === 'string'
        ) {
          yield { type: 'THINKING', content: (delta as any).reasoning_content as string };
        }

        // text
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
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(acc.arguments || '{}');
            } catch {
              // JSON parse error
            }
            yield { type: 'TOOL_USE', id: acc.id, name: acc.name, input };
          }
          toolCallAccumulators.clear();
          yield { type: 'STOP', reason: choice.finish_reason };
        }
      }
    } catch (error: unknown) {
      if (error instanceof OpenAI.APIError) {
        throw new Error(`${this.providerType} API error (${error.status}): ${error.message}`);
      }
      if (error instanceof Error) {
        throw new Error(`${this.providerType} stream error: ${error.message}`);
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
        let reasoningContent: string | undefined;

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
          } else if (block.type === 'thinking') {
            reasoningContent = (block as ThinkingContent).thinking;
          }
        }

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : (toolCalls.length > 0 ? '' : null),
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        // DeepSeek V4 等思考模型要求所有 assistant 消息必须带 reasoning_content
        // 参考 OpenClaw: ensureDeepSeekV4AssistantReasoningContent
        // 但当 assistant 只有 tool_calls 时，不添加 reasoning_content
        // 因为 DeepSeek 不接受 tool_calls + reasoning_content 的组合
        if (reasoningContent !== undefined) {
          (assistantMsg as unknown as Record<string, unknown>).reasoning_content = reasoningContent;
        } else if (toolCalls.length === 0) {
          (assistantMsg as unknown as Record<string, unknown>).reasoning_content = '';
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
            // 非视觉模型 → 降级为文本占位符
            if (!this.getCapabilities().vision) {
              const src = block.source;
              const label = src.type === 'base64'
                ? `[Image: ${src.media_type}]`
                : `[Image URL: ${src.url}]`;
              textParts.push(label);
            } else {
              const url = block.source.type === 'base64'
                ? `data:${block.source.media_type};base64,${block.source.data}`
                : block.source.url;
              imageParts.push({ type: 'image_url', image_url: { url } });
            }
          }
        }

        // tool_result 必须先于 user content
        result.push(...toolResults);
        if (imageParts.length > 0) {
          // 有图片时使用数组格式
          const content: OpenAI.ChatCompletionContentPart[] = [
            ...imageParts,
            ...(textParts.length > 0 ? [{ type: 'text' as const, text: textParts.join('') }] : []),
          ];
          result.push({ role: 'user', content });
        } else if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('') });
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

// ===== 工厂函数 =====

/** Groq — 高速推理 */
export function createGroqProvider(config?: { apiKey?: string; model?: string }) {
  const provCfg = getProviderConfigLoader().getProvider('groq');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'GROQ_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://api.groq.com/openai/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'groq',
  });
}

/** xAI / Grok */
export function createXAIProvider(config?: { apiKey?: string; model?: string }) {
  const provCfg = getProviderConfigLoader().getProvider('xai');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'XAI_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://api.x.ai/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'xai',
  });
}

/** Mistral AI */
export function createMistralProvider(config?: { apiKey?: string; model?: string }) {
  const provCfg = getProviderConfigLoader().getProvider('mistral');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'MISTRAL_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://api.mistral.ai/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'mistral',
  });
}

/** OpenRouter — 聚合网关（200+ 模型） */
export function createOpenRouterProvider(config?: { apiKey?: string; model?: string }) {
  const provCfg = getProviderConfigLoader().getProvider('openrouter');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://openrouter.ai/api/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'openrouter',
    headers: {
      'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_TITLE ?? 'Agent',
    },
  });
}

/** Moonshot / Kimi */
export function createMoonshotProvider(config?: { apiKey?: string; model?: string }) {
  const provCfg = getProviderConfigLoader().getProvider('moonshot');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'MOONSHOT_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://api.moonshot.cn/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'moonshot',
  });
}