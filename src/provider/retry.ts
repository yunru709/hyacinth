import { createLogger } from '../logging/logger.js';

const logger = createLogger('retry');

export interface RetryConfig {
  maxRetries: number;      // default 4
  baseDelayMs: number;     // default 1000
  maxDelayMs: number;      // default 30000
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/** 递归取错误链上的所有「码」（error.code 与 error.cause.code） */
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'string') codes.push(c.toUpperCase());
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes;
}

/** 递归取错误链上的所有 message（含 cause） */
function errorMessages(error: unknown): string[] {
  const msgs: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    msgs.push(cur.message.toLowerCase());
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return msgs;
}

/**
 * Check if an error is retryable.
 *
 * ⚠️ C-06（2026-10-22 修复）：旧实现**只看 `error.message`**。而 Node 内置 fetch 在
 * 连接被拒时给出的是 `message === 'fetch failed'`，真正的码在 `error.cause.code`
 * （`ECONNREFUSED`）⇒ 所有 pattern 都匹配不上 ⇒ `withRetry` 在 attempt 0 直接抛出，
 * **一次都不重试**（llamacpp 的整条重试链因此形同虚设）。
 * 现在同时看 `code` 与 `cause` 链。
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // 网络类错误码（Unicode 域名无关，统一大写比较）
  const NET_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
    'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH',
    'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
  ]);
  if (errorCodes(error).some((c) => NET_CODES.has(c))) return true;

  for (const msg of errorMessages(error)) {
    // Network errors
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('enotfound')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('timeout') || msg.includes('network')) return true;
    if (msg.includes('fetch failed') || msg.includes('socket hang up')) return true;
    // HTTP status codes in message
    if (msg.includes('status: 5') || msg.includes('status: 429')) return true;
    if (msg.includes('status: 502') || msg.includes('status: 503') || msg.includes('status: 504')) return true;
    // Anthropic SDK specific
    if (msg.includes('overloaded') || msg.includes('rate limit')) return true;
  }
  return false;
}

/** Check if an error is non-retryable (auth, bad request, etc) */
export function isNonRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // ⚠️ 2026-10-22 复核：与 isRetryableError 对称 —— 也必须穿透 cause 链。
  //    否则「401 被包成 fetch failed + cause」时这里看不见，而 isRetryableError 中
  //    `msg.includes('fetch failed')` 会判可重试 ⇒ 对着 401 白重试 3 次。
  //    调用顺序是 non-retryable 先判（withRetry 里），所以这里能看穿 cause 就等于优先拦截。
  for (const msg of errorMessages(error)) {
    if (msg.includes('status: 401') || msg.includes('status: 403')) return true;
    if (msg.includes('status: 404')) return true;
    if (msg.includes('invalid api key') || msg.includes('authentication')) return true;
  }
  return false;
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap an async function with retry logic.
 * Exponential backoff: 1s, 2s, 4s, 8s (capped at maxDelayMs)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  operationName: string = 'operation',
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Non-retryable errors fail immediately
      if (isNonRetryableError(error)) {
        throw error;
      }

      // Non-retryable errors (not in our retryable list) fail on first attempt
      if (attempt === 0 && !isRetryableError(error)) {
        throw error;
      }

      // Last attempt, give up
      if (attempt >= cfg.maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(cfg.baseDelayMs * Math.pow(2, attempt), cfg.maxDelayMs);
      logger.warn('retry attempt failed', { operation: operationName, attempt: attempt + 1, delay });
      await sleep(delay);
    }
  }

  throw lastError;
}
