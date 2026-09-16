/**
 * OpenAI 兼容系 usage → 缓存命中/未命中 token 的**字段探测**。
 *
 * 背景（真实现象）：各厂商在 `usage` 里暴露缓存字段的名字并不统一，而历史实现
 * （compatible / openai / local 三个适配器各写两行）**只读 DeepSeek 官方字段名**
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。结果：其他命名一律取不到
 * → 全链路 hit/miss 为 undefined → TUI 显示 `Cache: n/a`（代码里原本就留着 TODO）。
 *
 * 本模块按候选字段名依次探测，命中即归一化为 `{ hit, miss }`：
 *   1. DeepSeek 官方：`prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`（成对）
 *   2. OpenAI 系：`prompt_tokens_details.cached_tokens`（miss = prompt_tokens − hit）
 *   3. 部分代理/网关：直接字段 `cached_tokens` / `cache_hit_tokens` / `cache_read_input_tokens`
 *      （后两者为 Anthropic 风格命名在 OpenAI 兼容层里的复用）
 *
 * 注意：`prompt_tokens` 通常**已包含**命中部分，故 miss = max(0, prompt − hit)。
 */

/** 归一化后的缓存用量 */
export interface CacheUsage {
  /** 命中（被缓存复用）的输入 token 数 */
  hit: number;
  /** 未命中（需重新计费）的输入 token 数 */
  miss: number;
}

/** 安全取数：仅接受有限数字 */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 从一次 LLM 响应的 `usage` 中探测缓存用量。
 *
 * @param usage 原始 usage 对象（厂商返回，字段名不可信，故按候选名单探测）
 * @param promptTokens 已知的输入 token 数（usage 里没有 prompt_tokens 时的兜底来源）
 * @returns 归一化缓存用量；**任一必需量缺失即返回 undefined**（宁可不显示，也不显示错值）
 */
export function extractCacheUsage(
  usage: unknown,
  promptTokens?: number | undefined,
): CacheUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;

  // 1) DeepSeek 官方：hit / miss 成对返回，最精确，优先采用
  const hitPair = num(u.prompt_cache_hit_tokens);
  const missPair = num(u.prompt_cache_miss_tokens);
  if (hitPair !== undefined && missPair !== undefined) {
    return { hit: hitPair, miss: missPair };
  }

  // 2)/3) 只有"命中量"的厂商：用总输入量推导未命中部分
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const hit =
    num(details?.cached_tokens) ??
    num(u.cached_tokens) ??
    num(u.cache_hit_tokens) ??
    num(u.cache_read_input_tokens) ??
    hitPair;
  const prompt = num(u.prompt_tokens) ?? promptTokens;
  if (hit !== undefined && prompt !== undefined) {
    return { hit, miss: Math.max(0, prompt - hit) };
  }

  return undefined;
}
