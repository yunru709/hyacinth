/**
 * ProviderProbe — 候选厂商 API 可用性探测器。
 *
 * 降级链（FallbackProviderChain）的候选成员在入链前必须先通过本探测器验证
 * "真实可用"（key 有效 + 模型存在 + 配额充足 + 端点可达），而非仅检查
 * envKey 是否存在。探测采用极短 chat 请求（max_tokens=1），成本 ≈1 token。
 *
 * 缓存语义（外部可配，默认内置）：
 *  - ok           → cacheTtlMs（60s）内复用，不重复探测
 *  - unavailable  → failureCooldownMs（30s）内不再重探（key 无效/模型不存在）
 *  - uncertain    → uncertainCooldownMs（15s）后可重探（网络/5xx/超时）
 *
 * 并发安全：pending Map 共享在途探测，同一候选并发调用只发一次请求。
 */
import type { ProviderFactoryMeta } from './provider-meta.js';

export type ProbeStatus = 'ok' | 'unavailable' | 'uncertain';

export interface ProbeResult {
  status: ProbeStatus;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

export interface ProbeConfig {
  /** 单次探测请求超时（ms） */
  timeoutMs: number;
  /** ok 结果缓存有效期（ms） */
  cacheTtlMs: number;
  /** unavailable 结果冷却期（ms），期间不重探 */
  failureCooldownMs: number;
  /** uncertain 结果冷却期（ms），期间不重探 */
  uncertainCooldownMs: number;
}

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  timeoutMs: 5000,
  cacheTtlMs: 60_000,
  failureCooldownMs: 30_000,
  uncertainCooldownMs: 15_000,
};

// ─── 协议判定 ───────────────────────────────────────────────────────

type ProbeProtocol = 'openai' | 'anthropic' | 'gemini';

/**
 * 内置厂商的 meta.protocol 字段缺省（仅 JSON 声明厂商携带），协议由实现文件决定：
 *  - anthropic 系（baseUrl 为裸域名或 /anthropic 形态，拼 /v1/messages）：anthropic/qwen/minimax/mimo
 *  - gemini 无 /chat/completions，走 generateContent REST
 *  - 其余内置 + JSON 声明（缺省 openai）→ openai 系
 */
const ANTHROPIC_PROTOCOL_TYPES = new Set(['anthropic', 'qwen', 'minimax', 'mimo']);

function resolveProtocol(type: string, meta: ProviderFactoryMeta): ProbeProtocol {
  if (meta.protocol) return meta.protocol;
  if (type === 'gemini') return 'gemini';
  if (ANTHROPIC_PROTOCOL_TYPES.has(type)) return 'anthropic';
  return 'openai';
}

// ─── 端点后缀归一（兼容用户自定义代理 baseUrl 形态） ───────────────

function openaiEndpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

function anthropicEndpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  if (b.endsWith('/v1/messages')) return b;
  if (b.endsWith('/v1')) return `${b}/messages`;
  return `${b}/v1/messages`;
}

// ─── 结果分类 ───────────────────────────────────────────────────────

function classify(status: number, body: string, started: number): ProbeResult {
  const latencyMs = Date.now() - started;
  const err = body.slice(0, 200);
  if (status >= 200 && status < 300) return { status: 'ok', statusCode: status, latencyMs };
  // key 无效 / 欠费 / 模型不存在 / 端点不支持 → 判定不可用（长冷却）
  if (status === 401 || status === 403 || status === 400 || status === 404) {
    return { status: 'unavailable', statusCode: status, latencyMs, error: err };
  }
  // 限流 / 5xx / 其它 → 不确定（短冷却，可重探）
  return { status: 'uncertain', statusCode: status, latencyMs, error: err };
}

// ─── ProviderProbe ──────────────────────────────────────────────────

type CacheEntry = ProbeResult & { at: number };

export class ProviderProbe {
  private config: ProbeConfig;
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<ProbeResult>>();

  constructor(config?: Partial<ProbeConfig>) {
    this.config = { ...DEFAULT_PROBE_CONFIG, ...config };
  }

  /**
   * 探测候选厂商可用性。带缓存 + 在途去重：
   *  - 冷却期内直接返回缓存结果（零请求）
   *  - 并发调用共享同一在途探测
   */
  probe(meta: ProviderFactoryMeta, apiKey: string): Promise<ProbeResult> {
    const key = cacheKey(meta, apiKey);

    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlFor(cached.status)) {
      const { at: _at, ...rest } = cached;
      return Promise.resolve(rest);
    }

    const p = this.doProbe(meta, apiKey, key);
    this.pending.set(key, p);
    return p;
  }

  /** 探测通过但真实流失败的候选：失效缓存，下次失败重新探测 */
  invalidate(meta: ProviderFactoryMeta, apiKey: string): void {
    this.cache.delete(cacheKey(meta, apiKey));
  }

  getConfig(): Readonly<ProbeConfig> {
    return this.config;
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private ttlFor(status: ProbeStatus): number {
    switch (status) {
      case 'ok': return this.config.cacheTtlMs;
      case 'unavailable': return this.config.failureCooldownMs;
      case 'uncertain': return this.config.uncertainCooldownMs;
    }
  }

  private async doProbe(meta: ProviderFactoryMeta, apiKey: string, key: string): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const protocol = resolveProtocol(meta.id, meta);
      const result = protocol === 'gemini'
        ? await this.probeGemini(meta, apiKey)
        : protocol === 'anthropic'
          ? await this.probeChat(meta, apiKey, true)
          : await this.probeChat(meta, apiKey, false);
      this.cache.set(key, { ...result, at: Date.now() });
      return result;
    } catch (err: unknown) {
      const isAbort = (err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError';
      const result: ProbeResult = {
        status: 'uncertain',
        latencyMs: Date.now() - started,
        error: isAbort ? 'timeout' : (err as Error)?.message ?? String(err),
      };
      this.cache.set(key, { ...result, at: Date.now() });
      return result;
    } finally {
      this.pending.delete(key);
    }
  }

  private async probeChat(meta: ProviderFactoryMeta, apiKey: string, anthropic: boolean): Promise<ProbeResult> {
    const started = Date.now();
    const url = anthropic ? anthropicEndpoint(meta.baseUrl) : openaiEndpoint(meta.baseUrl);

    const doRequest = async (body: Record<string, unknown>): Promise<{ status: number; body: string }> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: anthropic
          ? {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            }
          : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      const text = await res.text().catch(() => '');
      return { status: res.status, body: text };
    };

    const chatBody = (tokenField: 'max_tokens' | 'max_completion_tokens'): Record<string, unknown> => ({
      model: meta.defaultModel,
      messages: [{ role: 'user', content: 'ping' }],
      [tokenField]: 1,
      stream: false,
    });

    // OpenAI o 系模型拒绝 max_tokens（400 且 body 提及）→ 重试 max_completion_tokens，消除假阴性
    let { status, body } = await doRequest(chatBody('max_tokens'));
    if (!anthropic && status === 400 && /max_tokens|max_completion_tokens/i.test(body)) {
      ({ status, body } = await doRequest(chatBody('max_completion_tokens')));
    }

    return classify(status, body, started);
  }

  private async probeGemini(meta: ProviderFactoryMeta, apiKey: string): Promise<ProbeResult> {
    const started = Date.now();
    const url =
      `${meta.baseUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(meta.defaultModel)}` +
      `:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const text = await res.text().catch(() => '');
    return classify(res.status, text, started);
  }
}

function cacheKey(meta: ProviderFactoryMeta, apiKey: string): string {
  return `${meta.id}|${meta.baseUrl}|${meta.defaultModel}|${apiKey.slice(-4)}`;
}
