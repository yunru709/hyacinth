/**
 * 缓存命中率的**汇总口径**（纯函数，便于单测）。
 *
 * 背景：`getTurnInfo` 原先只透出"最近一轮"的命中率（`cacheTurns.at(-1)`）。最近一轮噪声很大
 * —— 一次压缩、一次上下文突增都能把它压到很低，无法回答"缓存到底省了多少"。UI 要展示的应是
 * **会话级平均值**。
 *
 * 口径选择：**按 token 量加权**（Σhit / Σ(hit+miss)），而不是"各轮百分比的算术平均"。
 * 理由：一轮长上下文（十几万 token）与一轮短问答（几千 token）在成本上差几十倍，
 * 算术平均会把两者等权，得出与实际成本脱节的数字；加权平均等价于"整个会话的命中占比"。
 */
import type { CacheTurnRecord } from './turn-state.js';

/**
 * 计算加权平均缓存命中率（0-100，保留 1 位小数）。
 *
 * @param turns 逐轮缓存记录（可只传最近 N 轮的子集）
 * @returns 命中率百分比；**无有效 token 数据时返回 undefined**（UI 应显示 n/a 而非 0）
 */
export function averageHitRate(turns: readonly CacheTurnRecord[]): number | undefined {
  let hit = 0;
  let total = 0;
  for (const t of turns) {
    hit += t.hitTokens;
    total += t.hitTokens + t.missTokens;
  }
  if (total <= 0) return undefined;
  return Math.round((hit / total) * 1000) / 10;
}
