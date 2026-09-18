import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';
import crypto from 'node:crypto';
import type {
  Message,
  StreamEvent,
  ProviderType,
  ToolDefinition,
  MessageContent,
} from '../types.js';
import type { Provider, ProviderCapabilities } from './interface.js';
import { getModelInfo } from './catalog.js';
import { sanitizeText, sanitizeStrings } from './sanitize.js';
export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Gemini Provider — 使用 @google/genai SDK 调用 Google Gemini 模型。
 */
export class GeminiProvider implements Provider {
  private client: GoogleGenAI;
  private model: string;
  private maxOutputTokens: number;

  constructor(opts: GeminiProviderOptions = {}) {
    const apiKey =
      opts.apiKey ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Gemini API key is required. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable.',
      );
    }

    this.client = new GoogleGenAI({ apiKey });
    this.model = opts.model ?? 'gemini-3.6-flash';
    this.maxOutputTokens = getModelInfo('gemini', this.model)?.maxOutputTokens ?? 8192;
  }

  getProviderType(): ProviderType {
    return 'gemini';
  }

  getModel(): string {
    return this.model;
  }

  getCapabilities(): ProviderCapabilities {
    const info = getModelInfo('gemini', this.model);
    return {
      toolCalling: true,
      streaming: true,
      adapterSupport: false,
      maxContextTokens: info?.contextWindow ?? 1048576,
      isLocal: false,
      vision: info?.capabilities.vision ?? true, // Gemini models all support vision
      inputTypes: info?.capabilities.inputTypes ?? (info?.capabilities.vision ? ['text', 'image'] : ['text']),
    };
  }

  async *createStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const { systemInstruction, history, userMessage, userParts } = this.splitMessages(messages);

    const chat = this.client.chats.create({
      model: this.model,
      config: {
        systemInstruction: systemInstruction
          ? ({ role: 'user', parts: [{ text: systemInstruction }] } as Content)
          : undefined,
        tools: tools && tools.length > 0 ? this.convertTools(tools) : undefined,
        maxOutputTokens: this.maxOutputTokens,
      },
      history: history.length > 0 ? history : undefined,
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = await chat.sendMessageStream({
        message: (userParts && userParts.length > 0 ? userParts : userMessage || 'Hello') as any,
        config: { abortSignal: signal },
      });

      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        const parts = candidate.content?.parts ?? [];

        for (const part of parts) {
          // 工具调用：Gemini 经 part.functionCall 返回，必须显式 yield TOOL_USE，
          // 否则主循环永远拿不到工具调用请求（工具能力对该 Provider 失效）。
          if (part.functionCall?.name) {
            yield {
              type: 'TOOL_USE',
              id: part.functionCall.id ?? crypto.randomUUID(),
              name: part.functionCall.name,
              input: (part.functionCall.args ?? {}) as Record<string, unknown>,
            };
            continue;
          }
          if (part.text) {
            // thought 是布尔标记（非文本内容）：思考文本仍在 part.text 里
            if (part.thought) {
              yield { type: 'THINKING', content: part.text };
            } else {
              yield { type: 'TEXT', content: part.text };
            }
          }
        }

        // usage 通常只在最后一个 chunk 出现
        const um = chunk.usageMetadata;
        if (um && (um.promptTokenCount !== undefined || um.candidatesTokenCount !== undefined)) {
          yield {
            type: 'USAGE',
            input_tokens: um.promptTokenCount ?? 0,
            output_tokens: um.candidatesTokenCount ?? 0,
          };
        }
      }

      yield { type: 'STOP', reason: 'end_turn' };
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`Gemini API error: ${error.message}`);
      }
      throw error;
    }
  }

  private splitMessages(messages: Message[]): {
    systemInstruction?: string;
    history: Content[];
    userMessage: string;
    userParts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string }; functionResponse?: { name: string; response: Record<string, unknown> } }>;
  } {
    // 发送边界统一清洗：递归清洗全部将进 API 请求体的字符串（含 tool_use 参数 /
    // thinking 等单点漏网字段），与各 block 内部 sanitizeText 幂等。
    messages = sanitizeStrings(messages);
    const systemParts: string[] = [];
    const history: Content[] = [];
    let userMessage = '';
    let userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string }; fileData?: { fileUri: string }; functionResponse?: { name: string; response: Record<string, unknown> } }> | undefined;
    // tool_use id → 函数名映射：把后续 tool_result 转成结构化 functionResponse
    const toolUseNames = new Map<string, string>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];

      if (msg.role === 'system') {
        for (const b of blocks) {
          if (b.type === 'text') systemParts.push(sanitizeText(b.text));
        }
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: Array<Record<string, unknown>> = [];
        for (const b of blocks) {
          if (b.type === 'text') parts.push({ text: sanitizeText(b.text) });
          else if (b.type === 'thinking') parts.push({ text: b.thinking, thought: true });
          else if (b.type === 'tool_use') {
            toolUseNames.set(b.id, b.name);
            parts.push({ functionCall: { name: b.name, args: b.input, id: b.id } });
          }
        }
        if (parts.length > 0) {
          history.push({ role: 'model', parts: parts as Content['parts'] });
        }
        continue;
      }

      if (msg.role === 'user') {
        const textParts: string[] = [];
        const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
        const responseParts: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = [];
        // 多模态视频/音频（Gemini inlineData / fileData）
        const mediaParts: Array<{ inlineData?: { mimeType: string; data: string }; fileData?: { fileUri: string } }> = [];

        for (const b of blocks) {
          if (b.type === 'text') textParts.push(sanitizeText(b.text));
          else if (b.type === 'tool_result') {
            const fnName = toolUseNames.get(b.tool_use_id);
            if (fnName) {
              // 结构化 functionResponse：与上一条 functionCall 配对，保证工具调用闭环
              responseParts.push({
                functionResponse: {
                  name: fnName,
                  response: b.is_error ? { error: sanitizeText(b.content) } : { output: sanitizeText(b.content) },
                },
              });
            } else {
              // 找不到对应 tool_use（异常场景）：降级为文本，避免 API 报 400
              textParts.push(`[Tool result: ${sanitizeText(b.content.substring(0, 200))}]`);
            }
          } else if (b.type === 'image' && b.source.type === 'base64') {
            imageParts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
          } else if (b.type === 'image' && b.source.type === 'url') {
            // Gemini 也支持 fileData 引用远程图片
            imageParts.push({ inlineData: { mimeType: 'image/unknown', data: b.source.url } });
          } else if (b.type === 'video') {
            const supportsVideo = this.getCapabilities().inputTypes?.includes('video') ?? false;
            if (!supportsVideo) {
              textParts.push(`[Video: ${b.source.type === 'file' ? b.source.path : b.source.type === 'url' ? b.source.url : b.source.media_type}]`);
            } else if (b.source.type === 'base64') {
              mediaParts.push({ inlineData: { mimeType: b.media_type, data: b.source.data } });
            } else if (b.source.type === 'url') {
              mediaParts.push({ inlineData: { mimeType: b.media_type, data: b.source.url } });
            } else {
              mediaParts.push({ fileData: { fileUri: `file://${b.source.path}` } });
            }
          } else if (b.type === 'audio') {
            const supportsAudio = this.getCapabilities().inputTypes?.includes('audio') ?? false;
            if (!supportsAudio) {
              textParts.push(`[Audio: ${b.source.type === 'file' ? b.source.path : b.source.type === 'url' ? b.source.url : b.source.media_type}]`);
            } else if (b.source.type === 'base64') {
              mediaParts.push({ inlineData: { mimeType: b.media_type, data: b.source.data } });
            } else {
              textParts.push(`[Audio: ${b.source.type === 'url' ? b.source.url : b.source.path}]`);
            }
          }
        }

        const text = textParts.join('\n\n');
        const combinedParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string }; fileData?: { fileUri: string }; functionResponse?: { name: string; response: Record<string, unknown> } }> = [
          ...(text ? [{ text }] : []),
          ...imageParts,
          ...mediaParts,
          ...responseParts,
        ];

        const isLast = i === messages.length - 1;
        if (isLast) {
          if (combinedParts.length > 0) {
            userParts = combinedParts;
            userMessage = text;
          } else {
            userMessage = text || 'Hello';
          }
        } else {
          if (combinedParts.length > 0) {
            history.push({ role: 'user', parts: combinedParts as Content['parts'] });
          }
        }
      }
    }

    return {
      systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      history,
      userMessage: userMessage || 'Hello',
      userParts,
    };
  }

  private convertTools(tools: ToolDefinition[]) {
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ];
  }
}

/** 便捷工厂 */
export function createGeminiProvider(config?: { apiKey?: string; model?: string }): GeminiProvider {
  return new GeminiProvider(config);
}