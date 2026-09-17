import OpenAI from 'openai';
import type {
  Message,
  StreamEvent,
  ProviderType,
  ProviderConfig,
  ToolDefinition,
  MessageContent,
  ThinkingContent,
} from '../types.js';
import type { Provider, ProviderCapabilities } from './interface.js';
import { getModelInfo } from './catalog.js';
import { translateFields } from './fields.js';
import type { ProviderFields, ProviderSampling } from './fields.js';
import { recoverToolArguments, logToolArgsWarning } from './tool-args-recovery.js';
import { sanitizeText } from './sanitize.js';
import { extractCacheUsage } from './usage-cache.js';
import { dropOrphanToolMessages, dropOrphanToolCalls } from './message-sanitize.js';
/** OpenAIProvider 构造选项 */
export interface OpenAIProviderOptions {
  /** 必须提供 apiKey，或通过 OPENAI_API_KEY 环境变量自动读取 */
  apiKey?: string;
  /** 可选自定义 base URL（代理/兼容端点） */
  baseUrl?: string;
  /** 模型名称，默认 gpt-5.5 */
  model?: string;
  /** 单次请求最大输出 token 数。兼容旧键名 maxTokens。 */
  maxOutputTokens?: number;
  /** @deprecated 使用 maxOutputTokens */
  maxTokens?: number;
  /** 缓存隔离 ID，区分不同产品的缓存池。默认 "hyacinth"。 */
  userId?: string;
  /** 通用字段（userId 归一入口；工厂层已把 config.userId 并入） */
  fields?: ProviderFields;
  /** 采样参数（temperature/topP/penalties；翻译层注入请求 body） */
  sampling?: ProviderSampling;
  /** 通用字段 → wire 字段名覆盖（映射数据化：providers.json 可配置） */
  fieldMap?: Partial<Record<keyof ProviderFields, string>>;
}

/**
 * OpenAI Provider — 通过 openai SDK 实现流式调用。
 *
 * 支持：
 * - 流式返回 StreamEvent（TEXT / TOOL_USE / USAGE / STOP）
 * - 自动将内部 Message 格式转换为 OpenAI ChatCompletion 格式
 * - 支持 reasoning_content（部分兼容端点用于 thinking 输出）
 */
export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private thinkingEnabled = false;
  private userId?: string;
  private sampling?: ProviderSampling;
  private fieldMap?: Partial<Record<keyof ProviderFields, string>>;

  constructor(opts: OpenAIProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass apiKey in options.',
      );
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseUrl ?? process.env.OPENAI_BASE_URL,
    });

    this.model = opts.model ?? 'gpt-5.5';
    this.maxTokens = opts.maxOutputTokens                          // ① 临时覆盖
      ?? opts.maxTokens                                            // 向后兼容
      ?? getModelInfo('openai', this.model)?.maxOutputTokens       // ② 本机模型目录
      ?? 8192;                                                      // ③ 兜底
    this.userId = opts.fields?.userId ?? opts.userId; // 缺省兜底在 translateFields（openaiUser 协议）
    this.sampling = opts.sampling ?? getModelInfo('openai', this.model)?.sampling; // 三级兜底：激活配置 → 模型目录默认
    this.fieldMap = opts.fieldMap;
  }

  getProviderType(): ProviderType {
    return 'openai';
  }

  getModel(): string {
    return this.model;
  }

  getCapabilities(): ProviderCapabilities {
    const info = getModelInfo('openai', this.model);
    return {
      toolCalling: true,
      streaming: true,
      adapterSupport: false,
      maxContextTokens: info?.contextWindow ?? 128000,
      isLocal: false,
      vision: info?.capabilities.vision ?? false,
      inputTypes: info?.capabilities.inputTypes ?? (info?.capabilities.vision ? ['text', 'image'] : ['text']),
    };
  }

  setThinking(enabled: boolean): void {
    this.thinkingEnabled = enabled;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  async *createStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // ---- 构建请求参数 ----
    const openaiMessages = this.convertMessages(messages);

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: openaiMessages,
      max_tokens: this.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      params.tools = this.convertTools(tools);
    }

    // thinking 默认 enabled，必须显式发送 disabled 才能关闭
    (params as any).extra_body = {
      thinking: { type: this.thinkingEnabled ? 'enabled' : 'disabled' },
    };
    // 通用字段翻译：user（OpenAI 原生标准字段，滥用检测/按用户限流）+ 采样参数
    const { topLevel } = translateFields(
      'openaiUser',
      { ...this.sampling, userId: this.userId },
      this.fieldMap,
    );
    Object.assign(params as unknown as Record<string, unknown>, topLevel);

    // ---- 流式消费 ----
    // 追踪正在构建的 tool calls（OpenAI 的 tool call 是按 index 分片传输的）
    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      const stream = await this.client.chat.completions.create(params, { signal });

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        // ---- 处理 usage（最后一个 chunk） ----
        if (chunk.usage) {
          // 缓存字段按厂商候选名探测（见 usage-cache.ts；历史只认 DeepSeek 官方字段名
          // → 其他厂商一律 Cache: n/a）
          const cache = extractCacheUsage(chunk.usage, chunk.usage.prompt_tokens);
          yield {
            type: 'USAGE',
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
            cache_hit_tokens: cache?.hit,
            cache_miss_tokens: cache?.miss,
          };
        }

        if (!choice) continue;

        const delta = choice.delta;

        // ---- 处理 reasoning_content（thinking） ----
        if (
          'reasoning_content' in delta &&
          typeof delta.reasoning_content === 'string'
        ) {
          yield { type: 'THINKING', content: delta.reasoning_content as string };
        }

        // ---- 处理文本内容 ----
        if (delta.content) {
          yield { type: 'TEXT', content: delta.content };
        }

        // ---- 处理 tool calls ----
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

            // 首个分片包含 id 和 name
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }

        // ---- 处理 finish_reason ----
        if (choice.finish_reason) {
          // 先 emit 所有累积的 tool_use
          for (const [, acc] of toolCallAccumulators) {
            const raw = acc.arguments || '';
            const { recovered, complete, error } = recoverToolArguments(raw, acc.name);
            if (!complete) {
              logToolArgsWarning('openai', acc.name, raw, error);
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
        throw new Error(`OpenAI API error (${error.status}): ${error.message}`);
      }
      if (error instanceof Error) {
        throw new Error(`OpenAI stream error: ${error.message}`);
      }
      throw error;
    }
  }

  // ---- 内部转换方法 ----

  /**
   * 将内部 Message[] 转换为 OpenAI ChatCompletionMessageParam[]。
   *
   * 关键差异：
   * - Anthropic 格式中 tool_result 是 user 消息内的 content block
   * - OpenAI 格式中 tool_result 是独立的 role='tool' 消息
   * - Anthropic 格式中 tool_use 是 assistant 消息内的 content block
   * - OpenAI 格式中 tool_use 是 assistant 消息的 tool_calls 字段
   */
  private convertMessages(
    messages: Message[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    for (const msg of messages) {
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];

      if (msg.role === 'assistant') {
        // ---- assistant 消息 ----
        const textParts: string[] = [];
        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
        let reasoningContent: string | undefined;

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(sanitizeText(block.text));
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
          // tool_result 不应出现在 assistant 消息中，跳过
        }

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : (toolCalls.length > 0 ? '' : null),
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        // 思考模型要求 reasoning_content 回传
        // 当 assistant 只有 tool_calls 时不添加，避免 API 冲突
        if (reasoningContent !== undefined) {
          (assistantMsg as unknown as Record<string, unknown>).reasoning_content = reasoningContent;
        } else if (toolCalls.length === 0) {
          (assistantMsg as unknown as Record<string, unknown>).reasoning_content = '';
        }
        result.push(assistantMsg);
      } else {
        // ---- user 消息 ----
        // OpenAI 要求 role='tool' 消息紧跟在 assistant(tool_calls) 之后，
        // 不能被 user 文本消息隔开。因此先推 tool_result，再推 user 文本。
        const textParts: string[] = [];
        const toolResults: OpenAI.ChatCompletionToolMessageParam[] = [];
        const imageParts: OpenAI.ChatCompletionContentPartImage[] = [];

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(sanitizeText(block.text));
          } else if (block.type === 'tool_result') {
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: sanitizeText(block.content),
            });
          } else if (block.type === 'image') {
            const url = block.source.type === 'base64'
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source.url;
            imageParts.push({ type: 'image_url', image_url: { url } });
          }
        }

        result.push(...toolResults);
        if (imageParts.length > 0) {
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

    // 两向兜底：先剥「无回应的 tool_calls」（严格厂商 400 的主因），再丢「无主的 tool」
  return dropOrphanToolMessages(dropOrphanToolCalls(result));
  }

  /** 将内部 ToolDefinition[] 转换为 OpenAI ChatCompletionTool[] */
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

/** 便捷工厂：从 ProviderConfig 创建 OpenAIProvider */
export function createOpenAIProvider(config: ProviderConfig): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    userId: config.userId,
  });
}
