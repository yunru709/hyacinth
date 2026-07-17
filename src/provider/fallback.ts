/**
 * FallbackProviderChain — tries a list of providers in order.
 *
 * Each provider in the chain gets its own ResilientProvider wrapper for
 * individual retry + circuit breaker, then the chain tries them
 * sequentially until one succeeds.
 *
 * Example config:
 *   primary: anthropic/claude-sonnet-4-20250514
 *   fallback: [openai/gpt-4o, deepseek/deepseek-v4-flash]
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
}

export class FallbackProviderChain implements Provider {
  private providers: ResilientProvider[];
  private retryConfig: Partial<RetryConfig>;
  private cbConfig: Partial<CircuitBreakerConfig>;
  private onFallback?: (from: Provider, to: Provider, error: Error) => void;

  constructor(config: FallbackChainConfig) {
    if (config.providers.length === 0) {
      throw new Error('FallbackProviderChain requires at least one provider');
    }
    this.retryConfig = config.retry ?? {};
    this.cbConfig = config.circuitBreaker ?? {};
    this.onFallback = config.onFallback;
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
        // Success — track which provider actually worked
        if (i > 0 && this.lastSuccessfulIdx !== i) {
          this.lastSuccessfulIdx = i;
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
        this.onFallback?.(provider, nextProvider, err);

        continue;
      }
    }
  }
}