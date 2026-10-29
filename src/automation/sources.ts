/**
 * AutomationRule 的 Source 装配（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这一层
 * ────────────────────────────────────────────────────────────────────────────
 * 规则里三种 when，落地方式完全不同：
 *
 *   event —— 被动等待（钩子/外部事件广播）⇒ **不需要 arm**
 *   probe —— 需要**主动启动一个采样器**（WatchService 的 watcher）
 *   time  —— 需要**挂到时间源**（scheduler / tick）
 *
 * 本模块负责 probe 类的 arm：把规则的 `when.probe` 变成真实运行的 watcher，
 * 并维护 `ruleId → watchId` 映射（这是 runtime 精确匹配的依据，防止
 * 同一 kind 下多个监控互相串线）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么用"最小接口"而不是 import WatchService
 * ────────────────────────────────────────────────────────────────────────────
 * automation 与 watch 是两个业务核心，互相 import 会形成跨层环（verify:layers 会红）。
 * 这里只声明需要的两个方法（start / stop），由装配层把真实实例传进来。
 */

import type { AutomationRule } from './types.js';

/** 本模块需要的 watch 最小面 */
export interface WatchArmer {
  start(
    spec: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): { watchId: string };
  stop(watchId: string): void;
}

export interface ArmResult {
  /** ruleId → watchId */
  armed: Map<string, string>;
  /** 单条规则 arm 失败的原因（不阻断其它规则） */
  errors: string[];
}

/**
 * 为所有 **enabled 的 probe 类规则** 启动 watcher。
 *
 * 注意 order：**先全部 stop 旧的，再 start 新的**（由调用方保证 disarmAll 先跑），
 * 否则热更时会残留旧 watcher ⇒ 同一事件触发两次。
 *
 * @param rules  当前生效规则（调用方从 getCurrentAutomationRules() 取）
 * @param watch  watch 服务（真实实例或测试替身）
 */
export function armProbeRules(rules: readonly AutomationRule[], watch: WatchArmer): ArmResult {
  const armed = new Map<string, string>();
  const errors: string[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.when.kind !== 'probe') continue;

    const { probe, intervalMs, cooldownMs, threshold, settleFrames } = rule.when;

    try {
      // WatchSpec 的形态是 `{ kind, ...spec }` —— 把规则里拆开的两段合回去
      const spec: Record<string, unknown> = { kind: probe.kind, ...probe.spec };
      const info = watch.start(spec, {
        // note 用规则名，便于 watch_list 里一眼看出这条监控属于哪条规则
        note: `[automation] ${rule.name}`,
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(cooldownMs !== undefined ? { cooldownMs } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(settleFrames !== undefined ? { settleFrames } : {}),
        // once=false：规则是长期存在的，命中后应继续监控（冷却由 cooldownMs 控制）
        once: false,
      });
      armed.set(rule.id, info.watchId);
    } catch (err) {
      // 单条规则 arm 失败不阻断其它规则，但必须留痕（否则又是"配了没反应"）
      errors.push(`规则 "${rule.name}"(${rule.id}) arm 失败: ${(err as Error).message}`);
      console.error(`[automation] ${errors[errors.length - 1]}`);
    }
  }

  return { armed, errors };
}

/** 停掉一批 watcher（热更规则前调用，避免新旧 watcher 并存导致重复触发） */
export function disarmWatchIds(watch: WatchArmer, watchIds: Iterable<string>): void {
  for (const id of watchIds) {
    try {
      watch.stop(id);
    } catch {
      /* 已停止/不存在都不影响后续 */
    }
  }
}
