// ============================================================
// builtin-mode-hooks —— 框架自带、供**声明式模式**引用的具名钩子
// ============================================================
//
// 为什么需要这个文件：声明式 profile（.agent/modes/*.json）只能声明**静态**部分
// （工具面 / section 过滤 / source 覆写）。任何**带状态的动态行为**（比如"按距上次
// 注入的间隔概率注入时间戳"）都装不进 JSON —— 必须落在一个具名钩子里。
//
// 这里放的是**框架级**通用钩子（不是某个模式专有）：声明式模式按名引用即可，
// 不必各自重写一遍。少了它，"新增一个模式"就仍然要碰代码 ✗ —— 那正是这次
// 重构想解决的事。
//
// 注册时机：bootstrap-wiring 里、**loadModeProfiles 之前**（顺序要紧：profile
// 引用钩子名，取不到时 DeclarativeRouter 会静默走"无钩子"分支 ⇒ 行为悄悄缺失）。
//
// 缘起（2026-09-30）：为验证声明式通道而造的「测试模式」要等价普通模式，
// 时间戳概率注入是它唯一的动态依赖 —— 于是把这条判定抽成框架自带钩子。
// ============================================================

import type { SectionEntry } from './manifest-types.js';
import type { ResolverContext } from './section-resolver.js';
import { registerModeHook } from './mode-profile.js';
import { timestampInjectProbability, parseLocalTimestamp } from './router.js';

/** 钩子名（profile 里按名引用；用常量避免字面量散落） */
export const HOOK_TIMESTAMP_PROBABILISTIC = 'timestamp-probabilistic';

/** 上次时间戳实际注入的时刻（按会话隔离）——驱动间隔概率 */
const lastInjectAt = new Map<string, number>();

/**
 * 「按距上次注入的间隔给概率」的时间戳注入 —— 与 NormalRouter.beforeSection
 * **同一套判定**（1 分钟内 50%、5 分钟以上必中、中间线性；未命中不推进基准；
 * 按会话隔离）。概率函数直接复用 timestampInjectProbability，不另立一份。
 */
export async function timestampProbabilisticHook(
  sec: SectionEntry,
  ctx: ResolverContext,
): Promise<string | null | undefined> {
  if (sec.name !== 'timestamp') return undefined;

  const key = ctx.sessionDir ?? '__default__';
  const now = parseLocalTimestamp(ctx.timestamp) ?? Date.now();
  const last = lastInjectAt.get(key);
  const gapMs = last === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - last);

  if (Math.random() < timestampInjectProbability(gapMs)) {
    lastInjectAt.set(key, now); // 命中才推进基准
    return undefined;           // 放行 → 正常生成时间戳文本
  }
  return null;                  // 未命中 → 本轮不注入
}

/** 注册全部框架自带钩子（启动时调用一次；重复调用幂等） */
export function registerBuiltinModeHooks(): void {
  registerModeHook(HOOK_TIMESTAMP_PROBABILISTIC, timestampProbabilisticHook);
}
