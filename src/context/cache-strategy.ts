import type { ProviderType } from '../types.js';

// ── Types ──────────────────────────────────────────────────────────

/** 描述 messages[] 中一条消息在缓存断点中的位置 */
export interface CacheMarker {
  /** messages[] 中的全局索引（0-based） */
  index: number;
  type: 'ephemeral';
}

/** Zone 组装后的结构信息，供策略决定在哪些消息上打点 */
export interface ZoneInfo {
  /** Zone 标识（如 "zone1", "zone3"） */
  key: string;
  /** 该 Zone 产出的消息数 */
  msgCount: number;
}

export interface ComputeMarkersInput {
  zones: ZoneInfo[];
}

// ── Strategy interface ─────────────────────────────────────────────

/**
 * 缓存策略模式（cache mode），区分不同厂商的缓存实现方式。
 *
 *   - `none`           — 无缓存支持（本地模型等）
 *   - `auto-prefix`    — 厂商自动对比请求前缀字节，无需手动干预
 *   - `manual-markers` — 需在消息上打 cache_control 断点（Anthropic）
 *   - `pre-create`     — 需预先创建缓存对象，推理时引用 ID（Gemini 显式）
 */
export type CacheMode = 'none' | 'auto-prefix' | 'manual-markers' | 'pre-create';

/**
 * CacheStrategy — 缓存策略接口。
 *
 * 不同厂商对前缀缓存的机制完全不同：
 *   - Anthropic：manual-markers — 在消息上打 cache_control 标记（最多 4 断点）
 *   - DeepSeek / OpenAI / 其他：auto-prefix — 自动前缀匹配
 *   - Gemini：双重 — implicit=auto-prefix (2.5+默认), explicit=pre-create (CachedContent API)
 *   - local / llamacpp：none — 无缓存
 *
 * 新增厂商适配：
 *   1. 确定其 cacheMode
 *   2. 如为 manual-markers，实现 computeMarkers()
 *   3. 调用 registerStrategy(providerType, strategy)
 */
export interface CacheStrategy {
  /** 策略名（用于日志/调试） */
  readonly name: string;
  /** 适用的 ProviderType */
  readonly providerType: ProviderType;
  /** 缓存模式 */
  readonly cacheMode: CacheMode;
  /** 该厂商支持的最大断点数（manual-markers 模式有效） */
  readonly maxMarkers: number;

  /** 是否需要在消息上打 cache_control 断点（仅 manual-markers 返回 true） */
  shouldApplyMarkers(): boolean;

  /** 根据 Zone 结构计算断点位置（manual-markers 模式调用） */
  computeMarkers(input: ComputeMarkersInput): CacheMarker[];

  /**
   * 返回预创建缓存所需的静态 Zone key 列表（pre-create 模式调用）。
   *
   * 对于 Gemini 显式缓存：返回 ['zone1', 'zone2'] 表示应预注册 Z1+Z2 内容。
   * Provider 读取 zonesToPreCreate 后从消息中提取对应内容，调用 CachedContent API。
   *
   * 返回空数组表示不预创建（auto-prefix / manual-markers 模式）。
   */
  zonesToPreCreate?(): string[];
}

// ── Built-in strategies ────────────────────────────────────────────

/**
 * Anthropic 缓存策略（manual-markers 模式）。
 *
 * 4 个 cache_control 断点覆盖所有稳定前缀：
 *   BP1  → Zone 1 第一条消息（system prompt）
 *   BP2  → Zone 2 第一条消息（工具规则 + skill/agent/mcp 索引）
 *   BP3a → Zone 3 第一条消息（项目上下文 + 摘要）
 *   BP3b → Zone 3 第二条消息（历史首条，若存在）
 */
class AnthropicCacheStrategy implements CacheStrategy {
  readonly name = 'anthropic';
  readonly providerType: ProviderType = 'anthropic';
  readonly cacheMode: CacheMode = 'manual-markers';
  readonly maxMarkers = 4;

  shouldApplyMarkers(): boolean {
    return true;
  }

  computeMarkers(input: ComputeMarkersInput): CacheMarker[] {
    const markers: CacheMarker[] = [];
    let offset = 0;

    for (const zone of input.zones) {
      if (zone.msgCount === 0) continue;

      switch (zone.key) {
        case 'zone1':
          markers.push({ index: offset, type: 'ephemeral' });       // BP1
          break;
        case 'zone2':
          markers.push({ index: offset, type: 'ephemeral' });       // BP2
          break;
        case 'zone3':
          markers.push({ index: offset, type: 'ephemeral' });       // BP3a
          if (zone.msgCount > 1) {
            markers.push({ index: offset + 1, type: 'ephemeral' }); // BP3b
          }
          break;
        default:
          break;
      }

      if (markers.length >= this.maxMarkers) {
        return markers.slice(0, this.maxMarkers);
      }
      offset += zone.msgCount;
    }

    return markers;
  }
}

/**
 * Gemini 缓存策略（双重模式）。
 *
 * 隐式缓存（Gemini 2.5+ 默认启用）：
 *   - 自动匹配请求前缀，最小 token: Flash≥1024 / Pro≥4096
 *   - 无需手动标记，等价于 auto-prefix
 *
 * 显式缓存（CachedContent API，保证命中 + 约 10% 成本）：
 *   - 预创建缓存对象：POST /v1beta/cachedContents
 *   - TTL：默认 1h，最长 90 天（7776000s）
 *   - 仅可修改 TTL，不可修改内容
 *   - 推理时引用：{ cachedContent: "cachedContents/xxx", contents: [...] }
 *
 * 当前走隐式路径（auto-prefix）。
 * TODO: 实现显式路径 — GeminiProvider 在首次调用时预注册 Z1+Z2 为 CachedContent。
 */
class GeminiCacheStrategy implements CacheStrategy {
  readonly name = 'gemini';
  readonly providerType: ProviderType = 'gemini';
  readonly cacheMode: CacheMode = 'auto-prefix';
  readonly maxMarkers = 0;

  shouldApplyMarkers(): boolean {
    return false;
  }

  computeMarkers(_input: ComputeMarkersInput): CacheMarker[] {
    return [];
  }

  // 显式缓存路径预留：返回需要预注册的 Zone
  // zonesToPreCreate(): string[] {
  //   return ['zone1', 'zone2'];
  // }
}

/**
 * 自动前缀缓存策略（auto-prefix 模式）。
 *
 * 适用于：
 *   - DeepSeek（AutoPrefixCacheStrategy）
 *   - OpenAI（自动前缀匹配）
 *   - Groq / xAI / Mistral / OpenRouter / Moonshot（OpenAI 兼容）
 *   - local / llamacpp（无缓存，maxMarkers=0）
 */
class AutoPrefixCacheStrategy implements CacheStrategy {
  readonly name = 'auto-prefix';
  readonly providerType: ProviderType;
  readonly cacheMode: CacheMode = 'auto-prefix';
  readonly maxMarkers = 0;

  constructor(providerType: ProviderType) {
    this.providerType = providerType;
  }

  shouldApplyMarkers(): boolean {
    return false;
  }

  computeMarkers(_input: ComputeMarkersInput): CacheMarker[] {
    return [];
  }
}

// ── Registry ───────────────────────────────────────────────────────

const STRATEGIES = new Map<string, CacheStrategy>();

// 注册内置策略
STRATEGIES.set('anthropic', new AnthropicCacheStrategy());
STRATEGIES.set('gemini', new GeminiCacheStrategy());

/**
 * 注册自定义缓存策略（供插件或未来新厂商使用）。
 *
 * @example
 *   registerStrategy('my-provider', new MyProviderCacheStrategy());
 */
export function registerStrategy(
  providerType: ProviderType,
  strategy: CacheStrategy,
): void {
  STRATEGIES.set(providerType, strategy);
}

/**
 * 根据 ProviderType 查找对应的缓存策略。
 * 未注册的 Provider 回退到 AutoPrefixCacheStrategy（零标记 + 自动前缀）。
 */
export function getCacheStrategy(providerType: ProviderType): CacheStrategy {
  return (
    STRATEGIES.get(providerType) ??
    new AutoPrefixCacheStrategy(providerType)
  );
}
