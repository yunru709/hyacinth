import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  StreamEvent,
  ProviderType,
  ProviderConfig,
  ToolDefinition,
  MessageContent,
} from '../types.js';
import type { Provider, ProviderCapabilities } from './interface.js';
import { getModelInfo } from './catalog.js';

/** AnthropicProvider 构造选项（在 ProviderConfig 基础上扩展） */
export interface AnthropicProviderOptions {
  /** 必须提供 apiKey，或通过 ANTHROPIC_API_KEY 环境变量自动读取 */
  apiKey?: string;
  /** 可选自定义 base URL（代理/企业端点） */
  baseUrl?: string;
  /** 模型名称，默认 claude-sonnet-4-20250514 */
  model?: string;
  /** 最大输出 token 数，默认 16384 */
  maxTokens?: number;
  /** 是否启用 extended thinking，默认 false */
  thinkingEnabled?: boolean;
  /** thinking 预算 token 数，默认 10000（仅在 thinkingEnabled=true 时生效） */
  thinkingBudget?: number;
  /** 覆盖 ProviderType（MiniMax/Qwen/Zhipu/MiMo 等兼容协议用） */
  providerType?: ProviderType;
}

/**
 * Anthropic Provider — 通过 @anthropic-ai/sdk 实现流式调用。
 *
 * 支持：
 * - Extended Thinking（thinking 模式）
 * - Prompt Caching（cache_control 标记）— message 层面的断点由 context/cache-strategy.ts 统一管理
 * - 流式返回 StreamEvent（TEXT / THINKING / TOOL_USE / USAGE / STOP）
 */
export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private thinkingEnabled: boolean;
  private thinkingBudget: number;

  private _providerType: ProviderType;

  constructor(opts: AnthropicProviderOptions = {}) {
    this._providerType = opts.providerType ?? 'anthropic';
    const isAnthropic = this._providerType === 'anthropic';
    const apiKey = opts.apiKey ?? (isAnthropic ? process.env.ANTHROPIC_API_KEY : undefined);
    if (!apiKey) {
      const label = isAnthropic ? 'Anthropic' : this._providerType.toUpperCase();
      const envVar = isAnthropic ? 'ANTHROPIC_API_KEY' : `${this._providerType.toUpperCase()}_API_KEY`;
      throw new Error(
        `${label} API key is required. Set ${envVar} environment variable or pass apiKey in options.`,
      );
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL,
    });

    this.model = opts.model ?? 'claude-sonnet-4-20250514';
    this.maxTokens = opts.maxTokens ?? getModelInfo('anthropic', this.model)?.maxTokens ?? 16384;
    this.thinkingEnabled = opts.thinkingEnabled ?? false;
    this.thinkingBudget = opts.thinkingBudget ?? 10000;
  }

  getProviderType(): ProviderType {
    return this._providerType;
  }

  getModel(): string {
    return this.model;
  }

  getCapabilities(): ProviderCapabilities {
    const info = getModelInfo('anthropic', this.model);
    return {
      toolCalling: true,
      streaming: true,
      adapterSupport: false,
      maxContextTokens: info?.contextWindow ?? 200000,
      isLocal: false,
      vision: info?.capabilities.vision ?? true, // Anthropic models mostly support vision
    };
  }

  /** 运行时切换 thinking 模式 */
  setThinking(enabled: boolean, budget: number = 10000): void {
    this.thinkingEnabled = enabled;
    this.thinkingBudget = budget;
  }

  async *createStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // ---- 构建请求参数 ----
    // 使用 MessageCreateParamsNonStreaming（stream 字段可选），stream() 方法内部会自动设置 stream: true
    const { system, messages: filteredMessages } = this.extractSystemAndMessages(messages);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: filteredMessages,
    };

    // system prompt（Anthropic API 要求通过 system 参数传递，不能出现在 messages 中）
    if (system) {
      params.system = system;
    }

    // tools
    if (tools && tools.length > 0) {
      params.tools = this.convertTools(tools);
    }

    // thinking
    if (this.thinkingEnabled) {
      params.thinking = {
        type: 'enabled' as const,
        budget_tokens: this.thinkingBudget,
      };
    }

    // ---- 流式消费 ----
    const stream = this.client.messages.stream(params, { signal });

    // 追踪正在构建的 tool_use
    let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
    // 累计 usage
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens: number | undefined;
    let cacheCreationInputTokens: number | undefined;

    try {
      for await (const event of stream) {
        switch (event.type) {
          // ---- message_start：获取初始 usage ----
          case 'message_start': {
            const usage = event.message.usage;
            if (usage) {
              inputTokens = usage.input_tokens;
              if (usage.cache_read_input_tokens != null) {
                cacheReadInputTokens = usage.cache_read_input_tokens;
              }
              if (usage.cache_creation_input_tokens != null) {
                cacheCreationInputTokens = usage.cache_creation_input_tokens;
              }
            }
            break;
          }

          // ---- content_block_start：检测 tool_use / thinking 块 ----
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              currentToolUse = {
                id: block.id,
                name: block.name,
                inputJson: '',
              };
            }
            // thinking 块的起始没有内容需要 emit，等待 delta
            break;
          }

          // ---- content_block_delta：增量文本 / thinking / tool input ----
          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'TEXT', content: delta.text };
            } else if (delta.type === 'thinking_delta') {
              yield { type: 'THINKING', content: delta.thinking };
            } else if (delta.type === 'input_json_delta') {
              if (currentToolUse) {
                currentToolUse.inputJson += delta.partial_json;
              }
            }
            break;
          }

          // ---- content_block_stop：完成 tool_use 块 ----
          case 'content_block_stop': {
            if (currentToolUse) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(currentToolUse.inputJson || '{}');
              } catch (e) {
                console.warn(`[anthropic] JSON parse failed for tool "${currentToolUse.name}": ${(e as Error).message}`);
                console.warn(`[anthropic] raw (first 500 chars): ${(currentToolUse.inputJson || '').slice(0, 500)}`);
              }
              yield {
                type: 'TOOL_USE',
                id: currentToolUse.id,
                name: currentToolUse.name,
                input,
              };
              currentToolUse = null;
            }
            break;
          }

          // ---- message_delta：stop_reason + output usage ----
          case 'message_delta': {
            if (event.usage) {
              outputTokens = event.usage.output_tokens;
            }
            if (event.delta.stop_reason) {
              // 先 emit USAGE，再 emit STOP
              const usageEvent: StreamEvent = {
                type: 'USAGE',
                input_tokens: inputTokens,
                output_tokens: outputTokens,
              };
              if (cacheReadInputTokens != null) {
                usageEvent.cache_read_input_tokens = cacheReadInputTokens;
              }
              if (cacheCreationInputTokens != null) {
                usageEvent.cache_creation_input_tokens = cacheCreationInputTokens;
              }
              yield usageEvent;
              yield { type: 'STOP', reason: event.delta.stop_reason };
            }
            break;
          }

          // message_stop / 其他事件不需要特殊处理
          default:
            break;
        }
      }
    } catch (error: unknown) {
      if (error instanceof Anthropic.APIError) {
        throw new Error(`Anthropic API error (${error.status}): ${error.message}`);
      }
      if (error instanceof Error) {
        throw new Error(`Anthropic stream error: ${error.message}`);
      }
      throw error;
    }
  }

  // ---- 内部转换方法 ----

  /**
   * 从消息列表中提取 system 消息和 user/assistant 消息。
   *
   * Anthropic API 要求 system prompt 通过 `system` 参数传递，
   * 不能出现在 messages 数组中。此方法将 role='system' 的消息提取出来，
   * 拼接为 system 字符串或 TextBlockParam 数组（含 cache_control 时），
   * 仅 role='user' 和 role='assistant' 的消息进入 messages 数组。
   */
  private extractSystemAndMessages(messages: Message[]): {
    system?: string | Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    const filteredMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // 提取 system 消息的内容块
        const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
        for (const block of blocks) {
          if (block.type === 'text') {
            const textBlock: Anthropic.TextBlockParam = {
              type: 'text' as const,
              text: block.text,
            };
            // 传递 cache_control 标记
            if (block.cache_control) {
              textBlock.cache_control = block.cache_control;
            }
            systemBlocks.push(textBlock);
          }
          // system 消息中的非 text 块（如 tool_use / tool_result）忽略
        }
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        const content = Array.isArray(msg.content) ? msg.content : [msg.content];
        filteredMessages.push({
          role: msg.role,
          content: this.convertContentBlocks(content),
        });
      }
    }

    // 构建 system 参数
    let system: string | Anthropic.TextBlockParam[] | undefined;
    if (systemBlocks.length > 0) {
      // 检查是否有任何 block 带有 cache_control
      const hasCacheControl = systemBlocks.some((b) => b.cache_control != null);
      if (hasCacheControl) {
        // 有 cache_control 时使用数组格式
        system = systemBlocks;
      } else {
        // 无 cache_control 时使用纯字符串格式
        system = systemBlocks.map((b) => b.text).join('\n\n');
      }
    }

    return { system, messages: filteredMessages };
  }

  /** 将内部 Message[] 转换为 Anthropic MessageParam[]（已废弃，保留兼容） */
  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => {
        const content = Array.isArray(msg.content) ? msg.content : [msg.content];
        return {
          role: msg.role as 'user' | 'assistant',
          content: this.convertContentBlocks(content),
        };
      });
  }

  /** 转换内容块，必要时添加 cache_control 标记 */
  private convertContentBlocks(
    blocks: MessageContent[],
  ): Anthropic.ContentBlockParam[] {
    const result: Anthropic.ContentBlockParam[] = [];
    for (let idx = 0; idx < blocks.length; idx++) {
      const block = blocks[idx];
      const isLast = idx === blocks.length - 1;

      switch (block.type) {
        case 'text': {
          const textBlock: Anthropic.TextBlockParam = { type: 'text' as const, text: block.text };
          // If the content block already has cache_control (set by composer), pass it through
          if (block.cache_control) {
            textBlock.cache_control = block.cache_control;
          }
          result.push(textBlock);
          break;
        }

        case 'tool_use':
          result.push({
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;

        case 'tool_result':
          result.push({
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id,
            content: block.content,
            ...(block.is_error != null ? { is_error: block.is_error } : {}),
          });
          break;

        case 'thinking':
          // Anthropic API 不接受 thinking 块作为输入，跳过
          break;

        case 'image': {
          if (!this.getCapabilities().vision) {
            // 非视觉模型 → 降级为文本占位符
            const src = block.source;
            result.push({
              type: 'text' as const,
              text: src.type === 'base64'
                ? `[Image: ${src.media_type}]`
                : `[Image URL: ${src.url}]`,
            } as Anthropic.TextBlockParam);
          } else {
            const mime = block.source.type === 'base64'
              ? (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(block.source.media_type)
                  ? block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
                  : 'image/png') // fallback: unsupported types → png
              : '';
            const src = block.source.type === 'base64'
              ? { type: 'base64' as const, media_type: mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: block.source.data }
              : { type: 'url' as const, url: block.source.url };
            const imgBlock = { type: 'image' as const, source: src } as Anthropic.ImageBlockParam;
            if (block.cache_control) {
              (imgBlock as unknown as Record<string, unknown>).cache_control = block.cache_control;
            }
            result.push(imgBlock);
          }
          break;
        }

        default:
          // 兜底：作为 text 块处理
          result.push({ type: 'text' as const, text: JSON.stringify(block) });
          break;
      }
    }
    return result;
  }

  /** 将内部 ToolDefinition[] 转换为 Anthropic Tool[] */
  private convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool, idx) => {
      const isLast = idx === tools.length - 1;
      const result: Anthropic.Tool = {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
      };
      // Note: cache_control on tools was previously gated behind this.cacheControl.
      // Message-level breakpoints are now handled by context/cache-strategy.ts via composer.
      // Tool-level cache_control is intentionally omitted — Anthropic's 4-breakpoint limit
      // is fully consumed by the 4 Zone-boundary message markers (BP1-BP3b).
      return result;
    });
  }
}

/** 便捷工厂：从 ProviderConfig 创建 AnthropicProvider */
export function createAnthropicProvider(config: ProviderConfig): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });
}
