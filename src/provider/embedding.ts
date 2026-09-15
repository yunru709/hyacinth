/**
 * Embedding Provider — 统一 embedding 接口 + OpenAI 兼容实现。
 *
 * 背景：厂商/中转站在 providers.json 里声明 capabilities.embedding 后，
 * embedding 能力即"声明即用"——无需再写任何生成侧/知识侧配置。
 *
 * 用法：
 *   const ep = getEmbeddingProvider();            // 自动找声明了 embedding 的厂商
 *   const ep = getEmbeddingProvider('my_gateway'); // 指定厂商
 *   const r = await ep.embed({ input: ['文本1', '文本2'] });
 *
 * 协议：POST {baseUrl}/embeddings（OpenAI 风格，baseUrl 需含 /v1），
 * 请求体 {model, input}，响应 {data:[{index, embedding}], usage}。
 *
 * 不接 knowledge（retriever 集成留作后续）；本模块只负责"取向量"。
 */

import { getProviderConfigLoader } from './config.js';
import type { ProviderFactoryMeta } from './provider-meta.js';

// ── 接口 ────────────────────────────────────────────────────────────

export interface EmbeddingRequest {
  /** 模型名；缺省用厂商声明的 capabilities.embedding.model */
  model?: string;
  /** 单个或批量文本 */
  input: string | string[];
}

export interface EmbeddingUsage {
  promptTokens?: number;
  totalTokens?: number;
}

export interface EmbeddingResult {
  /** 供应商 id（providers.json 里的 key） */
  provider: string;
  /** 实际使用的模型 */
  model: string;
  /** 与 input 一一对应的向量 */
  embeddings: number[][];
  usage?: EmbeddingUsage;
}

/** 统一 embedding 供应商接口（与对话 Provider / 生成 GenerationProvider 并列） */
export interface EmbeddingProvider {
  readonly providerType: string;
  embed(req: EmbeddingRequest): Promise<EmbeddingResult>;
}

// ── OpenAI 兼容实现 ────────────────────────────────────────────────

export interface OpenAICompatibleEmbeddingOptions {
  /** 供应商 id（溯源用） */
  providerType: string;
  apiKey: string;
  /** OpenAI 风格 baseUrl（含 /v1，如 https://api.openai.com/v1） */
  baseUrl: string;
  /** 默认模型 */
  model: string;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly providerType: string;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(opts: OpenAICompatibleEmbeddingOptions) {
    if (!opts.apiKey) {
      throw new Error(`embedding provider "${opts.providerType}" requires an API key`);
    }
    if (!opts.baseUrl) {
      throw new Error(`embedding provider "${opts.providerType}" requires a baseUrl`);
    }
    this.providerType = opts.providerType;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResult> {
    const model = req.model ?? this.model;
    if (!model) {
      throw new Error(`embedding provider "${this.providerType}" has no model (declare capabilities.embedding.model)`);
    }
    const input = Array.isArray(req.input) ? req.input : [req.input];
    if (input.length === 0 || input.some(t => !t.trim())) {
      throw new Error('[embedding] input 不能为空');
    }

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`embedding 请求失败 ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as {
      data?: Array<{ index?: number; embedding: number[] }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    // OpenAI 响应不保证顺序——按 index 排序后与 input 对齐
    const items = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (items.length !== input.length) {
      throw new Error(
        `embedding 响应数量不匹配：请求 ${input.length} 条，返回 ${items.length} 条`,
      );
    }

    return {
      provider: this.providerType,
      model,
      embeddings: items.map(d => d.embedding),
      ...(data.usage
        ? { usage: { promptTokens: data.usage.prompt_tokens, totalTokens: data.usage.total_tokens } }
        : {}),
    };
  }
}

// ── 入口 ────────────────────────────────────────────────────────────

/**
 * 获取 embedding 供应商。
 * - vendorId 缺省：自动找第一个声明了 capabilities.embedding 的厂商
 * - vendorId 指定：该厂商（未声明 embedding 能力 → null）
 * - loader 未初始化 / 厂商无 embedding 能力 / 无 API key → null
 */
export function getEmbeddingProvider(vendorId?: string): EmbeddingProvider | null {
  let meta: ProviderFactoryMeta | undefined;
  try {
    const loader = getProviderConfigLoader();
    meta = vendorId ? loader.getProvider(vendorId) : loader.getAll().find(m => m.capabilities?.embedding);
  } catch {
    return null; // loader 未初始化（启动早期）
  }
  if (!meta) return null;

  const spec = meta.capabilities?.embedding;
  if (!spec) return null;

  const apiKey = meta.envKey ? (process.env[meta.envKey] ?? '') : '';
  if (!apiKey) return null;

  try {
    return new OpenAICompatibleEmbeddingProvider({
      providerType: meta.id,
      apiKey,
      baseUrl: meta.baseUrl,
      model: spec.model ?? meta.defaultModel ?? '',
    });
  } catch {
    return null; // 缺 key/baseUrl 等构造失败 → 视为未配置
  }
}
