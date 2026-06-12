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

/** Check if an error is retryable */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network errors
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('enotfound')) return true;
    if (msg.includes('timeout') || msg.includes('network')) return true;
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
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
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
