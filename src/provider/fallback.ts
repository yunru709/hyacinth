/**
 * FallbackProviderChain — tries a list of providers in order.
 *
 * Each provider in the chain gets its own ResilientProvider wrapper for
 * individual retry + circuit breaker, then the chain tries them
 * sequentially until one succeeds.
 *
 * Example config:
 *   primary: anthropic/claude-sonnet-5
 *   fallback: [openai/gpt-5.5, deepseek/deepseek-v4-flash-0731]
 */

import type { Provider } from './interface.js';
import type { Message, StreamEvent, ToolDefinition, ProviderType } from '../types.js';
import { ResilientProvider } from './resilient.js';
import type { RetryConfig, CircuitBreakerConfig } from './resilient.js';

export interface FallbackChainConfig {
  /** Providers in order: [0]=primary, [1..]=fallbacks */
  providers: Provider[];
  /** Retry config applied to each provider in the chain */
  retry?: Partial<RetryConfig>;
  /** Circuit breaker config applied to each provider in the chain */
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  /** Called when fallback from one provider to the next occurs */
  onFallback?: (from: Provider, to: Provider, error: Error) => void;
  /** Called when the chain recovers back to the primary provider (index 0 succeeds after being on a fallback). */
  onRecover?: (provider: Provider) => void;
}

export class FallbackProviderChain implements Provider {
  private providers: ResilientProvider[];
  private retryConfig: Partial<RetryConfig>;
  private cbConfig: Partial<CircuitBreakerConfig>;
  private onFallback?: (from: Provider, to: Provider, error: Error) => void;
  private onRecover?: (provider: Provider) => void;
  /**
   * 是否曾发生降级切换（onFallback 已触发）。
   * 用独立标志而非 lastSuccessfulIdx>0 判断恢复，因为存在「降级触发但 fallback
   * 也失败（lastSuccessfulIdx 未移出 0）」的场景——此时恢复主 provider 也必须触发
   * onRecover 以还原 maxContext，否则会卡在 fallback 窗口。
   */
  private hasFallenBack = false;

  constructor(config: FallbackChainConfig) {
    if (config.providers.length === 0) {
      throw new Error('FallbackProviderChain requires at least one provider');
    }
    this.retryConfig = config.retry ?? {};
    this.cbConfig = config.circuitBreaker ?? {};
    this.onFallback = config.onFallback;
    this.onRecover = config.onRecover;
    this.providers = config.providers.map(
      (p) => new ResilientProvider(p, this.retryConfig, this.cbConfig),
    );
  }

  /** Index of the last successfully used provider in the chain (0 = primary). */
  private lastSuccessfulIdx = 0;

  /** Returns true if currently running on a fallback (not the primary). */
  get isOnFallback(): boolean {
    return this.lastSuccessfulIdx > 0;
  }

  /** Get the currently active provider type (may differ from primary on fallback). */
  getActiveType(): ProviderType {
    return this.providers[this.lastSuccessfulIdx]?.getProviderType() ?? this.providers[0]!.getProviderType();
  }

  /** Get the currently active model (may differ from primary on fallback). */
  getActiveModel(): string {
    return this.providers[this.lastSuccessfulIdx]?.getModel() ?? this.providers[0]!.getModel();
  }

  getProviderType(): ProviderType {
    return this.providers[this.lastSuccessfulIdx]?.getProviderType()
      ?? this.providers[0]!.getProviderType();
  }

  getModel(): string {
    return this.providers[this.lastSuccessfulIdx]?.getModel()
      ?? this.providers[0]!.getModel();
  }

  getCapabilities() {
    return this.providers[this.lastSuccessfulIdx]?.getCapabilities?.()
      ?? this.providers[0]?.getCapabilities?.()
      ?? { toolCalling: false, streaming: true, adapterSupport: false, maxContextTokens: 4096, isLocal: false, vision: false };
  }

  setThinking(enabled: boolean, effort?: string | number): void {
    for (const p of this.providers) {
      p.setThinking(enabled, effort);
    }
  }

  setUserId(userId: string): void {
    for (const p of this.providers) {
      p.setUserId?.(userId);
    }
  }

  /** Return the underlying providers (for inspection) */
  getChainProviders(): ResilientProvider[] {
    return this.providers;
  }

  /** Set a fallback callback after construction (e.g. once configCenter is ready). */
  setOnFallback(cb: (from: Provider, to: Provider, error: Error) => void): void {
    this.onFallback = cb;
  }

  /** Set a recover callback after construction (e.g. once configCenter is ready). */
  setOnRecover(cb: (provider: Provider) => void): void {
    this.onRecover = cb;
  }

  async *createStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const errors: string[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const label = `${provider.getProviderType()}/${provider.getModel()}`;

      try {
        yield* provider.createStream(messages, tools, signal);
        // Success — track which provider actually worked.
        // Note: update even for i===0 so that recovering back to the primary
        // clears the stale fallback index (previously only updated for i>0).
        if (this.lastSuccessfulIdx !== i) {
          this.lastSuccessfulIdx = i;
        }
        // Recovered back to the primary provider after a prior fallback → notify
        // so callers can restore e.g. maxContext to the primary's window.
        // Use hasFallenBack (not lastSuccessfulIdx>0) so recovery also fires
        // when a fallback was attempted but also failed (lastSuccessfulIdx stayed 0).
        if (i === 0 && this.hasFallenBack) {
          this.hasFallenBack = false;
          this.onRecover?.(provider);
        }
        return;
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        const msg = err.message;
        errors.push(`[${label}] ${msg}`);

        // If last provider failed, throw aggregated error
        if (i === this.providers.length - 1) {
          throw new Error(
            `All ${this.providers.length} provider(s) failed:\n` +
              errors.map((e) => `  ${e}`).join('\n'),
          );
        }

        // Strip Anthropic cache_control markers before sending to next provider
        // (these were applied by composeCore for the primary provider and are
        // invalid for providers that don't use manual-markers mode)
        for (const msg of messages) {
          const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
          for (const block of blocks) {
            if ('cache_control' in block) {
              delete (block as unknown as Record<string, unknown>).cache_control;
            }
          }
        }

        // Notify callback so the system can adapt (context window, cache strategy, etc.)
        const nextProvider = this.providers[i + 1];
        this.hasFallenBack = true;
        this.onFallback?.(provider, nextProvider, err);

        continue;
      }
    }
  }
}