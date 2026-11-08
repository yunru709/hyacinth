/**
 * 统一 Provider 错误类型 —— 补上「失败可分类」这项职责（2026-11-08）。
 *
 * ## 为什么需要
 *
 * 此前四个适配器（openai / compatible / anthropic / gemini）在 catch 里把**所有**
 * 错误拍扁成一句字符串：
 *     throw new Error(`OpenAI API error (${error.status}): ${error.message}`);
 * 状态码、错误码、cause 链全在那一刻丢失，只剩文本。后果是下游只能靠**猜字符串**：
 *     context/compressor.ts:91   → 匹配 "400 Model is unavailable" 才触发压缩
 *     mcp/client.ts:199          → 同一句
 *     tools/result-buffer.ts:82  → 同一句
 * 换一家措辞不同的厂商，压缩就触发不了 —— 降级路径**靠巧合工作**。
 *
 * ## 设计约束（只增不减）
 *
 * `message` 一律**原样保留**适配器原来拼的那句（含 status），因为下游三处字符串
 * 匹配仍在服役；本模块只额外挂上结构化字段。因此接入本模块**不改变任何现有行为**，
 * 只是让"上下文超限"从此可被 `instanceof` / `kind` 精确识别。
 *
 * ## 与 retry 的关系
 *
 * `retry.ts` 判断"要不要重试"，本模块判断"这是哪一类错"。两者独立：
 * `retryable` 字段仅作参考提示，真正的重试决策仍在 `retry.ts`。
 */

/** 错误分类。命名刻意与业界惯例对齐，便于上层做 switch。 */
export type ProviderErrorKind =
  | 'auth'              // 401/403：密钥无效、无权限
  | 'rate_limit'        // 429：限流 / 额度用尽
  | 'context_overflow'  // 400/413 且语义是"上下文太长"——压缩器该介入的信号
  | 'invalid_request'   // 其他 4xx：请求体非法
  | 'server'            // 5xx / overloaded：上游故障
  | 'network'           // 连接失败、超时、socket 断开
  | 'unknown';

export interface ProviderErrorInit {
  /** 厂商类型（openai/anthropic/…），便于日志归因 */
  providerType?: string;
  /** HTTP 状态码（若能从原始错误中取到） */
  status?: number;
  /** 原始错误对象（保留 cause 链，供上层按需深挖） */
  original?: unknown;
  /** 上游建议的重试等待毫秒（429 常见 retry-after） */
  retryAfterMs?: number;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly providerType?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** 原始错误（保留完整 cause 链，勿丢） */
  readonly original?: unknown;

  constructor(message: string, kind: ProviderErrorKind, init: ProviderErrorInit = {}) {
    super(message);
    // name 用类名，便于 isAbortError 之类按 constructor.name 判定的路径正常工作
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = init.status;
    this.providerType = init.providerType;
    this.retryAfterMs = init.retryAfterMs;
    this.original = init.original;
    this.retryable = RETRYABLE_KINDS.has(kind);
  }

  /** 是否为上下文超限（压缩器可直接用，不必再匹配字符串） */
  isContextOverflow(): boolean {
    return this.kind === 'context_overflow';
  }
}

const RETRYABLE_KINDS = new Set<ProviderErrorKind>(['rate_limit', 'server', 'network']);

/** 网络类错误码（与 retry.ts 的 NET_CODES 同源，这里只用于分类） */
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
  'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH',
  'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
]);

/**
 * "上下文太长"的语义特征。
 *
 * ⚠️ `model is unavailable` 单独列出：opencode 等中转站对"请求处理不了"只回这句
 * 粗粒度报错（见 context/compressor.ts:91 的实测记录），其中最常见的原因就是超窗。
 * 把它归入 context_overflow 是为了让压缩器有确定的触发点，而不是继续猜。
 */
const CONTEXT_OVERFLOW_RE =
  /context[ _-]?length|too many tokens|maximum context|context window|token limit|request too large|payload too large|prompt is too long|model is unavailable/i;

/** 递归取错误链上的 code（error.code / cause.code …） */
function collectCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > 5) return [];
  const codes: string[] = [];
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') codes.push(code.toUpperCase());
  codes.push(...collectCodes((error as { cause?: unknown }).cause, depth + 1));
  return codes;
}

/** 从原始错误对象里尽力取出 HTTP 状态码（各 SDK 的字段名不同） */
export function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const s = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' ? s : undefined;
}

/** 纯分类：给定状态码 / 错误码 / 消息，判定 kind。可单独测试。 */
export function classifyProviderError(params: {
  message: string;
  status?: number;
  codes?: string[];
}): ProviderErrorKind {
  const { message, status } = params;
  const codes = params.codes ?? [];

  // 状态码优先（最确定）
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 413) return 'context_overflow';
  if (status !== undefined && status >= 500) return 'server';
  if (status === 400 || status === 422) {
    // 400 的语义要看文本：超窗 vs 其他非法请求
    return CONTEXT_OVERFLOW_RE.test(message) ? 'context_overflow' : 'invalid_request';
  }
  if (status !== undefined && status >= 400) return 'invalid_request';

  // 无状态码 → 看错误码 / 文本
  if (codes.some((c) => NETWORK_CODES.has(c))) return 'network';
  if (/fetch failed|socket hang up|ECONNREFUSED|ETIMEDOUT|network error|connect/i.test(message)) {
    return 'network';
  }
  if (CONTEXT_OVERFLOW_RE.test(message)) return 'context_overflow';
  if (/rate.?limit|too many requests|quota|insufficient/i.test(message)) return 'rate_limit';
  if (/unauthorized|invalid api key|authentication|permission/i.test(message)) return 'auth';
  if (/overloaded|service unavailable|internal server error|bad gateway|gateway timeout/i.test(message)) {
    return 'server';
  }
  return 'unknown';
}

/**
 * 把任意错误包装成 `ProviderError`，**`message` 原样保留**（调用方自己拼好传入）。
 *
 * @param message 适配器原本要抛出的那句（保持一字不变，下游字符串匹配继续有效）
 * @param original 原始错误（用于取 status / code / cause）
 */
export function toProviderError(
  message: string,
  original: unknown,
  init: Omit<ProviderErrorInit, 'original'> = {},
): ProviderError {
  // ⚠️ 中断必须**原样上抛**，绝不能被包装成本类：一旦包装，`name` 变成 'ProviderError'，
  // resilient/fallback 的 isAbortError 就再也认不出来 ⇒ 直接退回「Ctrl+C 停不下来」。
  // 因此本函数对中断有**副作用**（直接 throw 原始错误）。调用方写
  //     throw toProviderError(...)
  // 依然安全：中断时内层先抛，外层那个 throw 永不执行。
  if (isAbortLike(original)) throw original;

  const status = init.status ?? extractStatus(original);
  const codes = collectCodes(original);
  const kind = classifyProviderError({ message, status, codes });
  return new ProviderError(message, kind, { ...init, status, original });
}

/**
 * 从流式迭代中途抛出的错误里识别"这是用户中断"。
 * 与 resilient.ts 的 isAbortError 同口径（那里是权威实现），此处仅作薄封装，
 * 避免 provider 适配器为了一个判定去反向依赖 resilient 层。
 */
export function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const ctor = (err as { constructor?: { name?: string } }).constructor?.name;
  return name === 'AbortError' || name === 'APIUserAbortError'
    || ctor === 'AbortError' || ctor === 'APIUserAbortError';
}
