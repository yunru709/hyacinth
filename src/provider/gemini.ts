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
import type { ProviderSampling } from './fields.js';

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  /** 自定义端点（代理 / 反代 / 区域端点）—— 覆盖 SDK 默认（内部映射为 SDK 的 baseURL） */
  baseUrl?: string;
  /** 采样参数（temperature / topP → generationConfig） */
  sampling?: ProviderSampling;
}

/** 远程媒体下载上限：inlineData 要整体进请求体，过大不划算 */
const MAX_REMOTE_MEDIA_BYTES = 20 * 1024 * 1024;
/** 远程媒体下载超时 */
const REMOTE_MEDIA_TIMEOUT_MS = 15_000;

/**
 * 下载远程媒体并转为 Gemini 的 inlineData。
 *
 * 修复背景：URL 分支此前直接把**网址字符串**塞进 `inlineData.data`
 * （该字段语义是 base64 二进制），等于把垃圾放进请求体 —— 用 URL 传图/视频给
 * Gemini 必然异常。Gemini 的 `fileData` 只接受 Files API 上传后的 URI（或 gs://），
 * 故 URL 只能先下载再内联。
 *
 * 失败 / 空 / 超限 → 返回 null，由调用方降级为文本占位
 * （宁可丢掉这张图，也不要发出一个坏请求）。
 */
async function fetchRemoteMedia(
  url: string,
  fallbackMime: string,
): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REMOTE_MEDIA_TIMEOUT_MS) });
    if (!res.ok) return null;
    const declared = res.headers.get('content-type')?.split(';')[0]?.trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_REMOTE_MEDIA_BYTES) return null;
    return { mimeType: declared || fallbackMime, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

/**
 * Gemini Provider — 使用 @google/genai SDK 调用 Google Gemini 模型。
 */
export class GeminiProvider implements Provider {
  private client: GoogleGenAI;
  private model: string;
  private maxOutputTokens: number;
  private sampling?: ProviderSampling;

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

    // ⚠️ 字段名必须是 httpOptions.baseUrl —— @google/genai 的 GoogleGenAIOptions
    // **没有顶层 baseURL**（见 node_modules/@google/genai/dist/genai.d.ts：
    // `interface GoogleGenAIOptions { ...; httpOptions?: HttpOptions }`，
    // 而 `interface HttpOptions { baseUrl?: string; ... }`）。
    // 2026-10-07 实测（假上游对照）：顶层写法被 SDK **静默忽略** —— 自定义端点/代理
    // 完全不生效，请求照旧打 generativelanguage.googleapis.com（假上游一个请求都收不到，
    // 直接 fetch failed）；又因这里用了对象展开，绕过了 TS 的**多余属性检查**，tsc 从不报错。
    // 换成 httpOptions.baseUrl 后，同一假上游能正常收到
    // POST /v1beta/models/<model>:streamGenerateContent?alt=sse。
    // 回归保护：src/provider/stream-stop-synthesis.test.ts 的 Gemini 用例走假上游，
    // 若有人改回顶层写法，该用例会立刻红。
    this.client = new GoogleGenAI({
      apiKey,
      ...(opts.baseUrl ? { httpOptions: { baseUrl: opts.baseUrl } } : {}),
    });
    // 2026-10-02：移除第三层硬编码模型名（'gemini-3.6-flash'）—— 同 anthropic/openai。
    this.model = opts.model ?? 'unknown';
    this.maxOutputTokens = getModelInfo('gemini', this.model)?.maxOutputTokens ?? 8192;
    this.sampling = opts.sampling;
  }

  getProviderType(): ProviderType {
    return 'gemini';
  }

  getModel(): string {
    return this.model;
  }

  /** 运行时改单次输出上限（wire 的 maxOutputTokens）。见 Provider 接口说明。 */
  setMaxOutputTokens(maxOutputTokens: number): void {
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return;
    this.maxOutputTokens = maxOutputTokens;
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
    const { systemInstruction, history, userMessage, userParts } = await this.splitMessages(messages);

    const chat = this.client.chats.create({
      model: this.model,
      config: {
        systemInstruction: systemInstruction
          ? ({ role: 'user', parts: [{ text: systemInstruction }] } as Content)
          : undefined,
        tools: tools && tools.length > 0 ? this.convertTools(tools) : undefined,
        maxOutputTokens: this.maxOutputTokens,
        ...(this.sampling?.temperature !== undefined ? { temperature: this.sampling.temperature } : {}),
        ...(this.sampling?.topP !== undefined ? { topP: this.sampling.topP } : {}),
      },
      history: history.length > 0 ? history : undefined,
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = await chat.sendMessageStream({
        message: (userParts && userParts.length > 0 ? userParts : userMessage || 'Hello') as any,
        config: { abortSignal: signal },
      });

      // 记录上游给出的收尾原因（Gemini 放在 candidate.finishReason）。
      // ⚠️ 原实现是循环后**无条件** `yield { type: 'STOP', reason: 'end_turn' }` —— 于是
      // MAX_TOKENS（真的被截断）被冒充成正常结束，截断续写保护（只认 length/max_tokens/
      // incomplete）对 Gemini 从来就不生效。这里改为尊重上游信号。
      let lastFinishReason: string | undefined;
      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        // 末块才带 finishReason；后到的覆盖先到的（同一次流只会给一个终态）
        if (candidate.finishReason) lastFinishReason = String(candidate.finishReason);

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

      // ── 收尾：按上游 finishReason 归一（不再无条件 end_turn）──────────────
      //   STOP       → end_turn（正常）
      //   MAX_TOKENS → length（归一成通用语义，交给循环的截断保护提示 + 续写）
      //   其它        → 原样小写（SAFETY/RECITATION 等：不是长度问题，不该建议调上限）
      //   从未拿到    → incomplete（流被提前切断，同样交给截断保护）
      if (lastFinishReason === undefined) {
        yield { type: 'STOP', reason: 'incomplete' };
      } else if (lastFinishReason === 'MAX_TOKENS') {
        yield { type: 'STOP', reason: 'length' };
      } else if (lastFinishReason === 'STOP') {
        yield { type: 'STOP', reason: 'end_turn' };
      } else {
        yield { type: 'STOP', reason: lastFinishReason.toLowerCase() };
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`Gemini API error: ${error.message}`);
      }
      throw error;
    }
  }

  private async splitMessages(messages: Message[]): Promise<{
    systemInstruction?: string;
    history: Content[];
    userMessage: string;
    userParts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string }; fileData?: { fileUri: string }; functionResponse?: { name: string; response: Record<string, unknown> } }>;
  }> {
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
            // 必须下载后内联：inlineData.data 是 base64 二进制，塞网址会让请求体变成垃圾
            const fetched = await fetchRemoteMedia(b.source.url, 'image/png');
            if (fetched) {
              imageParts.push({ inlineData: fetched });
            } else {
              textParts.push(`[Image URL (fetch failed): ${b.source.url}]`);
            }
          } else if (b.type === 'video') {
            const supportsVideo = this.getCapabilities().inputTypes?.includes('video') ?? false;
            if (!supportsVideo) {
              textParts.push(`[Video: ${b.source.type === 'file' ? b.source.path : b.source.type === 'url' ? b.source.url : b.source.media_type}]`);
            } else if (b.source.type === 'base64') {
              mediaParts.push({ inlineData: { mimeType: b.media_type, data: b.source.data } });
            } else if (b.source.type === 'url') {
              const fetched = await fetchRemoteMedia(b.source.url, b.media_type);
              if (fetched) {
                mediaParts.push({ inlineData: fetched });
              } else {
                textParts.push(`[Video URL (fetch failed): ${b.source.url}]`);
              }
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
export function createGeminiProvider(config?: GeminiProviderOptions): GeminiProvider {
  return new GeminiProvider(config);
}
