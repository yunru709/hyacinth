import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';
import type {
  Message,
  StreamEvent,
  ProviderType,
  ToolDefinition,
  MessageContent,
} from '../types.js';
import type { Provider, ProviderCapabilities } from './interface.js';
import { getModelInfo } from './catalog.js';

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
    this.model = opts.model ?? 'gemini-2.5-flash';
    this.maxOutputTokens = getModelInfo('gemini', this.model)?.maxTokens ?? 8192;
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
          if (part.text) {
            yield { type: 'TEXT', content: part.text };
          }
          if (part.thought) {
            yield { type: 'THINKING', content: String(part.thought) };
          }
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
    userParts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  } {
    const systemParts: string[] = [];
    const history: Content[] = [];
    let userMessage = '';
    let userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> | undefined;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];

      if (msg.role === 'system') {
        for (const b of blocks) {
          if (b.type === 'text') systemParts.push(b.text);
        }
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: Array<{ text?: string }> = [];
        for (const b of blocks) {
          if (b.type === 'text') parts.push({ text: b.text });
          else if (b.type === 'tool_use') parts.push({ text: `[Tool: ${b.name}]` });
        }
        if (parts.length > 0) {
          history.push({ role: 'model', parts: parts as Content['parts'] });
        }
        continue;
      }

      if (msg.role === 'user') {
        const textParts: string[] = [];
        const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

        for (const b of blocks) {
          if (b.type === 'text') textParts.push(b.text);
          else if (b.type === 'tool_result') textParts.push(`[Tool result: ${b.content.substring(0, 200)}]`);
          else if (b.type === 'image' && b.source.type === 'base64') {
            imageParts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
          } else if (b.type === 'image' && b.source.type === 'url') {
            // Gemini 也支持 fileData 引用远程图片
            imageParts.push({ inlineData: { mimeType: 'image/unknown', data: b.source.url } });
          }
        }

        const isLast = i === messages.length - 1;
        if (isLast && imageParts.length > 0) {
          userParts = [
            ...(textParts.length > 0 ? [{ text: textParts.join('\n\n') }] : []),
            ...imageParts,
          ];
          userMessage = textParts.join('\n\n');  // fallback
        } else if (isLast) {
          userMessage = textParts.join('\n\n');
        } else {
          const text = textParts.join('\n\n');
          if (text || imageParts.length > 0) {
            const hParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
              ...(text ? [{ text }] : []),
              ...imageParts,
            ];
            history.push({ role: 'user', parts: hParts as Content['parts'] });
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