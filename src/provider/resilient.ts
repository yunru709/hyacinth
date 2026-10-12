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
import { getModelInfo } from './catalog.js';

// ─── Config types ──────────────────────────────────────────────────

export type { RetryConfig };

export interface CircuitBreakerConfig {
  /** Consecutive failures to open circuit (default: 5) */
  failureThreshold: number;
  /** Cooldown in ms before half-open (default: 30000) */
  cooldownMs: number;
  /**
   * 流空闲超时（ms）：createStream 开始后若在 idleTimeoutMs 内
   * 没有任何事件产出（网络半开 / 服务端挂起），主动中止底层流并抛错，
   * 走重试/降级链，避免无限等待 SDK 默认超时（OpenAI=10min）。
   * 0 = 禁用（不检查空闲）。
   *
   * ⚠️ 缺省值不再写死 90s，改由 resolveIdleTimeoutMs() 按模型思考能力自适应
   * —— 见下方常量注释里 2026-10-07 的实测事故。
   */
  idleTimeoutMs: number;
}

/**
 * 非思考模型的默认流空闲超时（ms）：2 分钟。
 * 这类模型逐 token 连续吐字，长时间静默几乎必然是连接问题。
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * 思考型模型的默认流空闲超时（ms）：10 分钟。
 *
 * 2026-10-07 实测事故（本文件曾被写死 90s，直接把长推理打残）：
 * DeepSeek-V4.1-Flash（思考模式）经聚合中转（commandcode）时，**推理阶段会
 * 长时间一个 delta 都不推** —— 会话事件流出现 **430s 连续空洞**，上游把推理
 * 内容缓冲到推理结束才一次性 flush（随后可见 1499 个 thinking 片段在 40s 内灌完）。
 * 90s 阈值因此把"正常思考"反复误判为"挂起"：abort + 重试（每次都从头生成，
 * 推理进度全丢），日志连打 5 次；最终那次流结束时没有 finish_reason，
 * stopReason 落空 ⇒ 被 finalize 默认成 end_turn ⇒ **静默截断、无任何提示**，
 * 用户侧只能看到"话说到一半没了"（实测该轮正文仅 272 字）。
 *
 * 协议上无法区分"正在思考"与"连接断了"（上游不发心跳），故只能放宽阈值；
 * 10 分钟 = 覆盖实测 430s 并留足余量。
 */
export const THINKING_IDLE_TIMEOUT_MS = 600_000;

/** 覆盖空闲超时的环境变量名（毫秒；0 = 禁用空闲检查）。 */
export const STREAM_IDLE_TIMEOUT_ENV = 'HYACINTH_STREAM_IDLE_TIMEOUT_MS';

/**
 * 解析本次生效的流空闲超时（ms）。优先级：
 *   ① 显式传入 cbConfig.idleTimeoutMs（含 0 = 禁用）
 *   ② 环境变量 HYACINTH_STREAM_IDLE_TIMEOUT_MS
 *   ③ 按模型是否声明 thinking 自适应（THINKING / DEFAULT）
 */
export function resolveIdleTimeoutMs(provider: Provider, explicit?: number): number {
  if (typeof explicit === 'number') return explicit;
  const envRaw = process.env[STREAM_IDLE_TIMEOUT_ENV];
  if (envRaw !== undefined && envRaw.trim() !== '') {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  // 模型目录可能查不到（自建/新增厂商）→ 保守用非思考值，不因查不到就放任无限等待。
  const info = getModelInfo(provider.getProviderType(), provider.getModel());
  return info?.capabilities.thinking ? THINKING_IDLE_TIMEOUT_MS : DEFAULT_IDLE_TIMEOUT_MS;
}

export const DEFAULT_CB: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, // 实际以 resolveIdleTimeoutMs() 为准
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

/**
 * 判定"用户主动中断"（Ctrl+C / message.stop → AbortController.abort）。
 *
 * 中断**不是**故障：任何重试/降级逻辑都必须立即原样上抛，否则会被
 * 当成 provider 失败处理，最终把中断聚合成 "All N provider(s) failed"，
 * error.name 也随之退化成 'Error' ⇒ 消费侧（llm.ts 白名单）识别不出中断。
 * 导出给 FallbackProviderChain 复用，保证两侧判定口径一致。
 */
export function isAbortError(err: Error): boolean {
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
    // idleTimeoutMs 走「显式 > 环境变量 > 模型思考能力自适应」三级解析（见 resolveIdleTimeoutMs）。
    // ⚠️ 不能只写 `{...DEFAULT_CB, ...cbConfig}`：cbConfig 一旦显式带 idleTimeoutMs: undefined，
    // 展开会把默认值冲成 undefined（本仓库踩过"配置键存在但值未定义"的同类坑）。
    this.cbConfig = {
      ...DEFAULT_CB,
      ...cbConfig,
      idleTimeoutMs: resolveIdleTimeoutMs(provider, cbConfig?.idleTimeoutMs),
    };
    this.name = `${provider.getProviderType()}/${provider.getModel()}`;
    this.logger = createLogger(`provider:resilient:${this.name}`);
    if (this.cbConfig.idleTimeoutMs > 0) {
      // 落一条 debug：这个值直接决定长推理会不会被误杀，排查时先看它。
      this.logger.debug('stream idle timeout resolved', {
        idleTimeoutMs: this.cbConfig.idleTimeoutMs,
        source: cbConfig?.idleTimeoutMs !== undefined
          ? 'explicit'
          : (process.env[STREAM_IDLE_TIMEOUT_ENV] ? 'env' : 'auto(thinking-aware)'),
      });
    }
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

  /** 必须转发：否则熔断包装下 max_tokens 热更静默失效（见 Provider 接口说明）。 */
  setMaxOutputTokens(maxOutputTokens: number): void {
    this.inner.setMaxOutputTokens?.(maxOutputTokens);
  }

  setUserId(userId: string): void {
    this.inner.setUserId?.(userId);
  }

  getCircuitState(): CircuitState {
    return this.cbState;
  }

  /** 重置熔断器为 closed（降级链兜底回退主 provider 前调用，给予完整重试窗口） */
  resetCircuitBreaker(): void {
    this.cbState = 'closed';
    this.failureCount = 0;
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

      // ── Track whether we've yielded any event ────────────────
      // 一旦 yield 过任何事件，重试必然导致 text/thinking 重复（已送出的无法撤回），
      // 此时再遇到错误直接抛出，不再重试。
      let hasYielded = false;

      // ── 空闲超时（治挂死）：网络半开/服务端挂起时流长时间无事件，
      //    用 Promise.race 包装迭代 —— 超时必然抛错（不依赖底层是否响应
      //    abort signal），转可重试错误走重试/降级链，而非无限等 SDK 默认超时。
      //    同时转发外层 signal（用户中断仍是 AbortError 直抛），与空闲超时区分。
      const idleMs = this.cbConfig.idleTimeoutMs;
      const innerAbort = new AbortController();
      let idleTimedOut = false;
      const forwardOuterAbort = () => innerAbort.abort();
      if (idleMs > 0) {
        signal?.addEventListener('abort', forwardOuterAbort, { once: true });
      }

      try {
        // ── Execute (manual iterator loop + idle timeout race) ──
        const innerStream = this.inner.createStream(
          messages,
          tools,
          idleMs > 0 ? innerAbort.signal : signal,
        );
        const iterator = innerStream[Symbol.asyncIterator]();
        // 记录最近事件时间，用于 idle race 每次迭代重新计时
        //（有事件产出 → 计时重置；长时间无事件 → 超时抛错）
        for (;;) {
          let lastEventAt = Date.now();
          // 兜底：若底层 iterator 无响应，Promise.race 超时分支必先 settle
          const nextOrTimeout: Promise<IteratorResult<StreamEvent>> = idleMs > 0
            ? Promise.race([
                iterator.next(),
                new Promise<never>((_resolve, reject) => {
                  setTimeout(() => {
                    idleTimedOut = true;
                    innerAbort.abort(); // 尽力让底层尽快中断（即使不响应也不阻塞）
                    reject(new Error(
                      `[ResilientProvider:${this.name}] stream idle timeout after ${idleMs}ms (no event in ${Date.now() - lastEventAt}ms)`,
                    ));
                  }, idleMs);
                }),
              ])
            : iterator.next();

          let res: IteratorResult<StreamEvent>;
          try {
            res = await nextOrTimeout;
          } catch (error: unknown) {
            throw error;
          }
          lastEventAt = Date.now();
          if (res.done) break;
          hasYielded = true;
          yield res.value;
        }
        // Success → reset
        this.onSuccess(attempt);
        return;
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));

        // ── 空闲超时触发 → 转可重试错误（非 AbortError，走重试/降级）──
        if (idleTimedOut) {
          const timeoutErr = new Error(
            `[ResilientProvider:${this.name}] stream idle timeout after ${idleMs}ms`,
          );
          if (hasYielded) { this.onFailure(timeoutErr); throw timeoutErr; }
          if (attempt === maxAttempts - 1) { this.onFailure(timeoutErr); throw timeoutErr; }
          if (!isRetryableError(timeoutErr)) { this.onFailure(timeoutErr); throw timeoutErr; }
          this.onFailure(timeoutErr);
          continue;
        }

        // ── Abort → rethrow immediately (never retry) ─────
        if (isAbortError(err)) {
          throw err;
        }

        // ── Already yielded → cannot retry without duplication ──
        if (hasYielded) {
          this.onFailure(err);
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
      } finally {
        signal?.removeEventListener('abort', forwardOuterAbort);
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