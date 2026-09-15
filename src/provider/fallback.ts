/**
 * FallbackProviderChain — tries a list of providers in order.
 *
 * Each provider in the chain gets its own ResilientProvider wrapper for
 * individual retry + circuit breaker, then the chain tries them
 * sequentially until one succeeds.
 *
 * 降级链成员必须"真实可用"：静态链（主 + 本地等免探测项）之外，还可携带
 * 未实例化的候选池（candidates）。主 provider 失败后，候选需先通过
 * ProviderProbe 探测（并行于主重试进行），仅探测 ok 者懒实例化入链继续尝试；
 * 探测不可用（key 无效/欠费/模型不存在）的候选直接跳过，不浪费重试时间。
 *
 * Example config:
 *   primary: anthropic/claude-sonnet-5
 *   fallback: [openai/gpt-5.5, deepseek/deepseek-v4-flash-0731]
 */

import type { Provider } from './interface.js';
import type { Message, StreamEvent, ToolDefinition, ProviderType } from '../types.js';
import { ResilientProvider } from './resilient.js';
import type { RetryConfig, CircuitBreakerConfig } from './resilient.js';
import { ProviderProbe } from './probe.js';
import type { ProbeResult } from './probe.js';
import type { ProviderFactoryMeta } from './provider-meta.js';

/** 未实例化的降级候选：探测 ok 后经 create() 懒实例化入链 */
export interface FallbackCandidate {
  meta: ProviderFactoryMeta;
  apiKey: string;
  create(): Provider;
}

export interface FallbackChainConfig {
  /** Providers in order: [0]=primary, [1..]=fallbacks（静态/免探测项） */
  providers: Provider[];
  /** 需探测的候选（未实例化；仅探测 ok 者懒实例化入链）。缺省 → 退化为纯静态链 */
  candidates?: FallbackCandidate[];
  /** 候选探测器。缺省 → candidates 不生效（兼容现状） */
  probe?: ProviderProbe;
  /**
   * 全部降级（静态 fallback + 动态候选）都失败后，是否回到最开始的主 provider
   * 重置熔断再试一轮（默认 true）——宁可等待重试也不中断长任务。
   */
  fallbackToPrimary?: boolean;
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
  /** 候选探测验证通过后懒实例化入链（链视图尾部追加） */
  private dynamicProviders: ResilientProvider[] = [];
  private candidates: FallbackCandidate[];
  private probe?: ProviderProbe;
  private fallbackToPrimary: boolean;
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
  /** 本次 createStream 的候选在途探测（与 candidates 对齐） */
  private probePromises: Promise<ProbeResult>[] = [];

  constructor(config: FallbackChainConfig) {
    if (config.providers.length === 0) {
      throw new Error('FallbackProviderChain requires at least one provider');
    }
    this.retryConfig = config.retry ?? {};
    this.cbConfig = config.circuitBreaker ?? {};
    this.onFallback = config.onFallback;
    this.onRecover = config.onRecover;
    this.candidates = config.candidates ?? [];
    this.probe = config.probe;
    this.fallbackToPrimary = config.fallbackToPrimary ?? true;
    this.providers = config.providers.map(
      (p) => new ResilientProvider(p, this.retryConfig, this.cbConfig),
    );
  }

  /** Index of the last successfully used provider in the chain (0 = primary). */
  private lastSuccessfulIdx = 0;

  /** 链视图 = 静态 providers + 已验证候选（懒增长） */
  private chainView(): ResilientProvider[] {
    return [...this.providers, ...this.dynamicProviders];
  }

  /** Returns true if currently running on a fallback (not the primary). */
  get isOnFallback(): boolean {
    return this.lastSuccessfulIdx > 0;
  }

  /** Get the currently active provider type (may differ from primary on fallback). */
  getActiveType(): ProviderType {
    return this.chainView()[this.lastSuccessfulIdx]?.getProviderType() ?? this.providers[0]!.getProviderType();
  }

  /** Get the currently active model (may differ from primary on fallback). */
  getActiveModel(): string {
    return this.chainView()[this.lastSuccessfulIdx]?.getModel() ?? this.providers[0]!.getModel();
  }

  getProviderType(): ProviderType {
    return this.chainView()[this.lastSuccessfulIdx]?.getProviderType()
      ?? this.providers[0]!.getProviderType();
  }

  getModel(): string {
    return this.chainView()[this.lastSuccessfulIdx]?.getModel()
      ?? this.providers[0]!.getModel();
  }

  getCapabilities() {
    return this.chainView()[this.lastSuccessfulIdx]?.getCapabilities?.()
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

  /** Return the underlying static providers (for inspection) */
  getChainProviders(): ResilientProvider[] {
    return this.providers;
  }

  /** 已验证候选（动态入链）数量 */
  get dynamicCount(): number {
    return this.dynamicProviders.length;
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

    // ── 预启动候选探测：与主 provider 重试（1→2→4→8s）并行，不阻塞 ──
    this.startCandidateProbes();

    // ── 尝试静态链（主 + 本地等免探测项）──
    let lastFailed: ResilientProvider | undefined;
    let lastErr: Error | undefined;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const label = `${provider.getProviderType()}/${provider.getModel()}`;

      try {
        yield* provider.createStream(messages, tools, signal);
        // Success — track which provider actually worked.
        if (this.lastSuccessfulIdx !== i) {
          this.lastSuccessfulIdx = i;
        }
        // Recovered back to the primary provider after a prior fallback → notify
        // so callers can restore e.g. maxContext to the primary's window.
        if (i === 0 && this.hasFallenBack) {
          this.hasFallenBack = false;
          this.onRecover?.(provider);
        }
        return;
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(`[${label}] ${err.message}`);
        lastFailed = provider;
        lastErr = err;
        this.stripCacheControl(messages);
        // 进入降级：静态链失败且后续仍有可用项（静态或候选池）→ 标记降级并回调
        const hasNext = i < this.providers.length - 1 || this.candidates.length > 0;
        if (hasNext) {
          this.hasFallenBack = true;
          if (i < this.providers.length - 1) {
            this.onFallback?.(provider, this.providers[i + 1]!, err);
          }
        }
      }
    }

    // ── 静态链全失败 → 等待候选探测，仅 ok 者懒实例化入链继续 ──
    if (this.candidates.length > 0 && this.probe) {
      const results = await this.awaitCandidateProbes();
      for (let i = 0; i < this.candidates.length; i++) {
        const cand = this.candidates[i];
        const res = results[i];
        // 探测未通过（不可用/不确定/未完成）→ 跳过，不浪费重试时间
        if (!res || res.status !== 'ok') {
          errors.push(
            `[candidate:${cand.meta.id}/${cand.meta.defaultModel}] skipped-${res?.status ?? 'no-probe'}${res?.statusCode !== undefined ? `(${res.statusCode})` : ''}`,
          );
          continue;
        }

        const rp = new ResilientProvider(cand.create(), this.retryConfig, this.cbConfig);
        this.dynamicProviders.push(rp);
        const label = `${rp.getProviderType()}/${rp.getModel()}`;

        // 通知回调：切到候选（懒实例化后仍包弹性层，链内自愈）
        this.hasFallenBack = true;
        if (lastFailed) {
          this.onFallback?.(lastFailed, rp, lastErr ?? new Error('previous provider failed'));
        }

        try {
          yield* rp.createStream(messages, tools, signal);
          this.lastSuccessfulIdx = this.providers.length + this.dynamicProviders.length - 1;
          return;
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push(`[${label}] ${err.message}`);
          // 探测通过但真实流失败 → 失效 ok 缓存，防下个窗口立即复用
          this.probe.invalidate(cand.meta, cand.apiKey);
          lastFailed = rp;
          lastErr = err;
          this.stripCacheControl(messages);
        }
      }
    }

    // ── 兜底：所有降级（静态 + 候选）都不可用时，回到最开始的主 provider 再试一轮 ──
    // 语义：宁可等待主 provider 重试恢复，也不让长任务中断。熔断 open 会 fail-fast，
    // 因此先重置熔断，给予完整重试窗口（指数退避）；若仍失败才抛聚合错误。
    if (this.fallbackToPrimary && this.providers.length > 0) {
      const primary = this.providers[0]!;
      primary.resetCircuitBreaker?.();
      try {
        yield* primary.createStream(messages, tools, signal);
        this.lastSuccessfulIdx = 0;
        if (this.hasFallenBack) {
          this.hasFallenBack = false;
          this.onRecover?.(primary);
        }
        return;
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(`[back-to-primary] ${err.message}`);
      }
    }

    // ── 全部失败：抛聚合错误（含候选探测标注）──
    throw new Error(
      `All ${this.providers.length + this.dynamicProviders.length} provider(s) failed:\n` +
        errors.map((e) => `  ${e}`).join('\n'),
    );
  }

  // ── 候选探测 ─────────────────────────────────────────────────────

  /** 对冷/过期候选发起探测（fire-and-forget：主重试期间并行完成） */
  private startCandidateProbes(): void {
    if (this.candidates.length === 0 || !this.probe) return;
    this.probePromises = this.candidates.map((c) => this.probe!.probe(c.meta, c.apiKey));
  }

  /** 等待在途探测结果（probe 内部已缓存+在途去重，≈0 额外请求） */
  private async awaitCandidateProbes(): Promise<ProbeResult[]> {
    if (this.probePromises.length === 0) return [];
    return Promise.all(this.probePromises);
  }

  /** 切换厂商前剥离 Anthropic cache_control 标记（对下一厂商无效） */
  private stripCacheControl(messages: Message[]): void {
    for (const msg of messages) {
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const block of blocks) {
        if ('cache_control' in block) {
          delete (block as unknown as Record<string, unknown>).cache_control;
        }
      }
    }
  }
}
