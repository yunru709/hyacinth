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
import { translateFields } from './fields.js';
import type { ProviderFields, ProviderSampling } from './fields.js';
import { recoverToolArguments, logToolArgsWarning } from './tool-args-recovery.js';
import { sanitizeText } from './sanitize.js';
import { extractCacheUsage } from './usage-cache.js';
import { dropOrphanToolMessages } from './message-sanitize.js';

/** media_type → OpenAI input_audio format（仅支持 wav/mp3，其余归 wav） */
function audioInputFormat(mediaType: string): 'wav' | 'mp3' {
  const m = mediaType.toLowerCase().split('/')[1];
  return m === 'mp3' ? 'mp3' : 'wav';
}

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
  /** 单次请求最大输出 token 数。兼容旧键名 maxTokens。 */
  maxOutputTokens?: number;
  /** @deprecated 使用 maxOutputTokens */
  maxTokens?: number;
  /** 额外的 HTTP 头（如 OpenRouter 要求的 HTTP-Referer / X-Title） */
  headers?: Record<string, string>;
  /** DeepSeek 缓存隔离 ID，区分不同产品的缓存池。默认 "hyacinth"。 */
  userId?: string;
  /** 通用字段（userId 归一入口；工厂层已把 config.userId 并入） */
  fields?: ProviderFields;
  /** 采样参数（temperature/topP/penalties；翻译层注入请求 body） */
  sampling?: ProviderSampling;
  /** 通用字段 → wire 字段名覆盖（JSON 声明厂商 meta.fieldMap 传入） */
  fieldMap?: Partial<Record<keyof ProviderFields, string>>;
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
 *   - Volcengine / 火山方舟 (ark.cn-beijing.volces.com)
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
  private reasoningEffort: DeepSeekReasoningEffort;
  private userId?: string;
  private sampling?: ProviderSampling;
  private fieldMap?: Partial<Record<keyof ProviderFields, string>>;

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
    const modelInfo = getModelInfo(opts.providerType, opts.model);
    this.maxTokens = opts.maxOutputTokens                  // ① 临时覆盖
      ?? opts.maxTokens                                    // 向后兼容
      ?? modelInfo?.maxOutputTokens                        // ② 本机模型目录
      ?? 8192;                                              // ③ 兜底
    this.reasoningEffort = modelInfo?.reasoningEffort ?? 'high';
    this.providerType = opts.providerType;
    this.userId = opts.fields?.userId ?? opts.userId; // 缺省兜底在 translateFields（openai 协议）
    this.sampling = opts.sampling ?? modelInfo?.sampling; // 三级兜底：激活配置 → 模型目录默认
    this.fieldMap = opts.fieldMap;
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
      inputTypes: info?.capabilities.inputTypes ?? (info?.capabilities.vision ? ['text', 'image'] : ['text']),
    };
  }

  setModel(model: string): void {
    this.model = model;
  }

  setThinking(enabled: boolean, effort?: DeepSeekReasoningEffort): void {
    this.thinkingEnabled = enabled;
    if (effort) this.reasoningEffort = effort;
  }

  setUserId(userId: string): void {
    this.userId = userId;
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
    // 通用字段翻译：user_id（DeepSeek 缓存隔离）+ 采样参数（temperature/topP/penalties）
    // 缺省兜底 DEFAULT_USER_ID 在 translateFields 内完成（与旧行为一致，始终发隔离字段）
    const { topLevel } = translateFields(
      'openai',
      { ...this.sampling, userId: this.userId },
      this.fieldMap,
    );
    Object.assign(params as unknown as Record<string, unknown>, topLevel);

    if (tools && tools.length > 0) {
      params.tools = this.convertTools(tools);
    }

    // DeepSeek thinking：默认 enabled，必须显式发送 disabled 才能关闭
    (params as any).extra_body = {
      thinking: { type: this.thinkingEnabled ? 'enabled' : 'disabled' },
    };
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
          // 缓存字段**按厂商候选名探测**（DeepSeek 官方 prompt_cache_hit_tokens/miss、
          // OpenAI 系 prompt_tokens_details.cached_tokens、以及兼容层里复用的
          // cached_tokens / cache_read_input_tokens）。
          // 历史实现只认 DeepSeek 官方字段名，其他厂商一律取不到 → 全链路 hit/miss 为
          // undefined → TUI 长期显示 `Cache: n/a`。
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
            const raw = acc.arguments || '';
            const { recovered, complete, error } = recoverToolArguments(raw, acc.name);
            if (!complete) {
              logToolArgsWarning('compatible', acc.name, raw, error);
            }
            // Even on incomplete recovery, still emit — allows partial execution
            yield { type: 'TOOL_USE', id: acc.id, name: acc.name, input: recovered };
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
        // 多模态视频/音频（OpenAI 兼容系 video_url / input_audio；SDK 类型滞后用 never 桥接）
        const videoParts: OpenAI.ChatCompletionContentPart[] = [];
        const audioParts: OpenAI.ChatCompletionContentPart[] = [];

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
          } else if (block.type === 'video') {
            const supportsVideo = this.getCapabilities().inputTypes?.includes('video') ?? false;
            const url = block.source.type === 'base64'
              ? `data:${block.media_type};base64,${block.source.data}`
              : block.source.type === 'url' ? block.source.url : null;
            if (!supportsVideo || url === null) {
              const label = block.source.type === 'file'
                ? `[Video file: ${block.source.path} — 需先抽帧/内联再发送]`
                : block.source.type === 'base64' ? `[Video: ${block.media_type}]` : `[Video URL: ${block.source.url}]`;
              textParts.push(label);
            } else {
              videoParts.push({
                type: 'video_url',
                video_url: {
                  url,
                  ...(block.sampling?.fps !== undefined ? { fps: block.sampling.fps } : {}),
                  ...(block.sampling?.max_frames !== undefined ? { max_frames: block.sampling.max_frames } : {}),
                },
              } as never);
            }
          } else if (block.type === 'audio') {
            const supportsAudio = this.getCapabilities().inputTypes?.includes('audio') ?? false;
            if (!supportsAudio || block.source.type !== 'base64') {
              const label = block.source.type === 'file'
                ? `[Audio file: ${block.source.path}]`
                : block.source.type === 'base64' ? `[Audio: ${block.media_type}]` : `[Audio URL: ${block.source.url}]`;
              textParts.push(label);
            } else {
              audioParts.push({
                type: 'input_audio',
                input_audio: { data: block.source.data, format: audioInputFormat(block.media_type) },
              } as never);
            }
          }
        }

        // tool_result 必须先于 user content
        result.push(...toolResults);
        if (imageParts.length > 0 || videoParts.length > 0 || audioParts.length > 0) {
          // 有多模态内容时使用数组格式
          const content: OpenAI.ChatCompletionContentPart[] = [
            ...imageParts,
            ...videoParts,
            ...audioParts,
            ...(textParts.length > 0 ? [{ type: 'text' as const, text: textParts.join('') }] : []),
          ];
          result.push({ role: 'user', content });
        } else if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('') });
        }
      }
    }

    return dropOrphanToolMessages(result);
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

/** 兼容族工厂参数（apiKey/model/userId + fields/sampling/maxOutputTokens/fieldMap 透传） */
export interface CompatibleFactoryConfig {
  apiKey?: string;
  model?: string;
  userId?: string;
  maxOutputTokens?: number;
  fields?: ProviderFields;
  sampling?: ProviderSampling;
  /** 通用字段 → wire 字段名覆盖（映射数据化：providers.json 可配置） */
  fieldMap?: Partial<Record<keyof ProviderFields, string>>;
}

export function createGroqProvider(config?: CompatibleFactoryConfig) {
  const provCfg = getProviderConfigLoader().getProvider('groq');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'GROQ_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://api.groq.com/openai/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'groq',
    userId: config?.userId,
    maxOutputTokens: config?.maxOutputTokens,
    fields: config?.fields,
    sampling: config?.sampling,
    fieldMap: config?.fieldMap,
  });
}

/** xAI / Grok */
export function createXAIProvider(config?: CompatibleFactoryConfig) {
  const provCfg = getProviderConfigLoader().getProvider('xai');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'XAI_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://api.x.ai/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'xai',
    userId: config?.userId,
    maxOutputTokens: config?.maxOutputTokens,
    fields: config?.fields,
    sampling: config?.sampling,
    fieldMap: config?.fieldMap,
  });
}

/** Mistral AI */
export function createMistralProvider(config?: CompatibleFactoryConfig) {
  const provCfg = getProviderConfigLoader().getProvider('mistral');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'MISTRAL_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://api.mistral.ai/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'mistral',
    userId: config?.userId,
    maxOutputTokens: config?.maxOutputTokens,
    fields: config?.fields,
    sampling: config?.sampling,
    fieldMap: config?.fieldMap,
  });
}

/** OpenRouter — 聚合网关（200+ 模型） */
export function createOpenRouterProvider(config?: CompatibleFactoryConfig) {
  const provCfg = getProviderConfigLoader().getProvider('openrouter');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://openrouter.ai/api/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'openrouter',
    userId: config?.userId,
    maxOutputTokens: config?.maxOutputTokens,
    fields: config?.fields,
    sampling: config?.sampling,
    fieldMap: config?.fieldMap,
    headers: {
      'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_TITLE ?? 'Agent',
    },
  });
}

/** Moonshot / Kimi */
export function createMoonshotProvider(config?: CompatibleFactoryConfig) {
  const provCfg = getProviderConfigLoader().getProvider('moonshot');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'MOONSHOT_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://api.moonshot.cn/v1',
    model: config?.model ?? provCfg?.defaultModel ?? 'unknown',
    providerType: 'moonshot',
    userId: config?.userId,
    maxOutputTokens: config?.maxOutputTokens,
    fields: config?.fields,
    sampling: config?.sampling,
    fieldMap: config?.fieldMap,
  });
}

/** 火山引擎（火山方舟 Ark）— 豆包 / Doubao Seed 系列（OpenAI 兼容协议）。
 *  默认走 Agent/Coding Plan 专属端点 + Plan 专属 Key + Plan 短名模型；
 *  通用 API Key 用户需覆盖 baseUrl（VOLCENGINE_BASE_URL 或 providers.json）
 *  为 https://ark.cn-beijing.volces.com/api/v3 并使用带日期后缀的 Model ID */
export function createVolcengineProvider(config?: CompatibleFactoryConfig) {
  const provCfg = getProviderConfigLoader().getProvider('volcengine');
  return new OpenAICompatibleProvider({
    apiKey: config?.apiKey,
    envKey: 'ARK_API_KEY',
    baseUrl: provCfg?.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/plan/v3',
    baseUrlEnv: 'VOLCENGINE_BASE_URL',
    model: config?.model ?? provCfg?.defaultModel ?? 'deepseek-v4-flash',
    providerType: 'volcengine',
    userId: config?.userId,
    maxOutputTokens: config?.maxOutputTokens,
    fields: config?.fields,
    sampling: config?.sampling,
    fieldMap: config?.fieldMap,
  });
}