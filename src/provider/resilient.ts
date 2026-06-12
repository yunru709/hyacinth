/**
 * ResilientProvider — wraps any Provider with retry + circuit breaker.
 *
 * Retry: exponential backoff (1s → 2s → 4s → 8s, max 4 retries)
 *   - Retryable: network errors, 5xx, 429 (rate limit)
 *   - Non-retryable: 4xx auth/validation errors
 *
 * Circuit breaker: after N consecutive failures, open for cooldown period.
 *   - Closed → Open (after failureThreshold consecutive failures)
 *   - Open → Half-open (after cooldownMs)
 *   - Half-open → Closed (on success) / Open (on failure)
 */

import type { Provider, ProviderCapabilities } from './interface.js';
import type { Message, StreamEvent, ToolDefinition, ProviderType } from '../types.js';
import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';
import type { RetryConfig } from './retry.js';
import { DEFAULT_RETRY_CONFIG } from './retry.js';

// ─── Config types ──────────────────────────────────────────────────

export type { RetryConfig };

export interface CircuitBreakerConfig {
  /** Consecutive failures to open circuit (default: 5) */
  failureThreshold: number;
  /** Cooldown in ms before half-open (default: 30000) */
  cooldownMs: number;
}

export const DEFAULT_CB: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

// ─── Helpers ───────────────────────────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /timeout/i,
  /rate.?limit/i,
  /too many requests/i,
  /service.?unavailable/i,
  /internal.?server.?error/i,
  /bad gateway/i,
  /gateway.?timeout/i,
];

function isRetryableError(error: Error): boolean {
  const message = error.message ?? '';
  // Check status code in message — match " 429 ", "HTTP 429", "status 429", etc.
  // Use word-boundary-like matching to avoid false positives (e.g. "tried 429 times")
  for (const code of RETRYABLE_STATUS_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(message)) return true;
  }
  // Check known error patterns
  for (const pattern of RETRYABLE_ERROR_PATTERNS) {
    if (pattern.test(message)) return true;
  }
  return false;
}

function isAbortError(err: Error): boolean {
  return err.name === 'AbortError' || err.name === 'APIUserAbortError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ResilientProvider ─────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

export class ResilientProvider implements Provider {
  private inner: Provider;
  private retryConfig: RetryConfig;
  private cbConfig: CircuitBreakerConfig;
  private logger: Logger;

  // Circuit breaker state
  private cbState: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly name: string;

  constructor(
    provider: Provider,
    retryConfig?: Partial<RetryConfig>,
    cbConfig?: Partial<CircuitBreakerConfig>,
  ) {
    this.inner = provider;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    this.cbConfig = { ...DEFAULT_CB, ...cbConfig };
    this.name = `${provider.getProviderType()}/${provider.getModel()}`;
    this.logger = createLogger(`provider:resilient:${this.name}`);
  }

  getProviderType(): ProviderType {
    return this.inner.getProviderType();
  }

  getModel(): string {
    return this.inner.getModel();
  }

  getCapabilities(): ProviderCapabilities {
    return this.inner.getCapabilities?.() ?? {
      toolCalling: false, streaming: true, adapterSupport: false,
      maxContextTokens: 4096, isLocal: false, vision: false,
    };
  }

  getInner(): Provider {
    return this.inner;
  }

  setThinking(enabled: boolean, effort?: string | number): void {
    this.inner.setThinking?.(enabled, effort);
  }

  getCircuitState(): CircuitState {
    return this.cbState;
  }

  async *createStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const maxAttempts = this.retryConfig.maxRetries + 1; // initial + retries

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // ── Circuit breaker check ─────────────────────────────────
      if (this.cbState === 'open') {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed < this.cbConfig.cooldownMs) {
          throw new Error(
            `[ResilientProvider:${this.name}] Circuit breaker OPEN. ` +
              `Cooldown in ${Math.ceil((this.cbConfig.cooldownMs - elapsed) / 1000)}s.`,
          );
        }
        // Transition to half-open
        this.cbState = 'half-open';
        this.logger.info('circuit breaker: half-open (trial)', { failures: this.failureCount });
      }

      // ── Backoff delay (skip first attempt) ──────────────────
      if (attempt > 0) {
        const delay = Math.min(
          this.retryConfig.baseDelayMs * Math.pow(2, attempt - 1),
          this.retryConfig.maxDelayMs,
        );
        this.logger.warn('retrying', { attempt, delayMs: delay });
        await sleep(delay);
      }

      try {
        // ── Execute ────────────────────────────────────────────
        yield* this.inner.createStream(messages, tools, signal);
        // Success → reset
        this.onSuccess(attempt);
        return;
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));

        // ── Abort → rethrow immediately (never retry) ─────
        if (isAbortError(err)) {
          throw err;
        }

        // ── Last attempt → fail ─────────────────────────────
        if (attempt === maxAttempts - 1) {
          this.onFailure(err);
          throw err;
        }

        // ── Non-retryable → fail immediately ────────────────
        if (!isRetryableError(err)) {
          this.onFailure(err);
          throw err;
        }

        // ── Retryable → record failure and loop ─────────────
        this.onFailure(err);
      }
    }
  }

  // ── Circuit breaker state transitions ──────────────────────────

  private onSuccess(attempts: number): void {
    if (this.failureCount > 0) {
      this.logger.info('recovered', { attempts: attempts + 1, previousFailures: this.failureCount });
    }
    this.failureCount = 0;
    this.cbState = 'closed';
  }

  private onFailure(err: Error): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.logger.warn('provider error', { error: err.message, failureCount: this.failureCount });
    if (
      this.cbState !== 'open' &&
      this.failureCount >= this.cbConfig.failureThreshold
    ) {
      this.cbState = 'open';
      this.logger.error('circuit breaker: opened', err, {
        cooldownMs: this.cbConfig.cooldownMs,
        failures: this.failureCount,
      });
    }
  }
}