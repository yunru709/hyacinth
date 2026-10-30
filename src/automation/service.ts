/**
 * Automation 运行时装配与派发入口（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 这个模块解决什么问题
 * ────────────────────────────────────────────────────────────────────────────
 * 规则定义（types/validate/store）、规则执行（runner/runtime）都已完成，
 * 但**没有任何东西把它们连起来**：
 *   · 谁持有 RunnerContext（invokeTool / wakeSession）？
 *   · 事件来了谁去查规则表并执行？
 *   · 规则里的 probe 类 when 谁来 arm watcher？
 *
 * 本模块就是那个"唯一入口"（收敛点①的落地形态）：
 *   装配层 setAutomationRuntime(deps) 一次 → 各事件源只调 dispatchAutomationEvent()
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么用进程级单例
 * ────────────────────────────────────────────────────────────────────────────
 * 规则表是**进程级配置**（一个文件、一个真相），事件源分散在 watch / scheduler /
 * hook 各处，它们都该看到同一份规则和同一个 RunnerContext。
 * 与 tool-links 的 setToolLinkRuntime 同法。
 *
 * ⚠️ 与 tool-links 的定位区别：
 *    tool-links = 框架内部的**工具旁路**（append 类，需要 tool 执行上下文）
 *    automation = 用户/模型定义的**自动化链路**（invoke/wake/gate/safety）
 *    两者共用 TriggerHub 派发思路与执行记录，但承载的内容不同。
 */

import type { RunnerContext } from './runner.js';
import type { AutomationEvent, RuleRunOutcome } from './runtime.js';
import { runMatchingRules } from './runtime.js';
import { getCurrentAutomationRules, saveAutomationRules } from './store.js';

/** 装配所需依赖 */
export interface AutomationRuntimeDeps extends RunnerContext {
  /** 规则 arm 后的 ruleId → watchId 映射（probe 类规则靠它精确匹配） */
  armedWatchIds?: ReadonlyMap<string, string>;
}

let deps: AutomationRuntimeDeps | null = null;

export function setAutomationRuntime(next: AutomationRuntimeDeps | null): void {
  deps = next;
}

export function getAutomationRuntime(): AutomationRuntimeDeps | null {
  return deps;
}

/**
 * 统一派发：事件 → 跑所有匹配的规则。
 *
 * 契约：
 *   · 未装配时静默返回空数组（单测/极简部署）；
 *   · **永不抛错** —— 调用方多是后台采样/调度循环，抛错会拖垮它们；
 *   · 每条规则的执行结果可通过返回值取出（供 UI / 诊断 / 模型自查）。
 *
 * @returns 每条匹配规则的执行结果（无匹配则为空数组）
 */
export async function dispatchAutomationEvent(
  event: AutomationEvent,
): Promise<RuleRunOutcome[]> {
  const d = deps;
  if (!d) return [];

  const rules = getCurrentAutomationRules();
  if (rules.length === 0) return [];

  try {
    const outcomes = await runMatchingRules(rules, event, d, d.armedWatchIds);
    applyMaxRuns(outcomes);
    return outcomes;
  } catch (err) {
    // runMatchingRules 内部已逐条隔离，走到这里说明是框架级错误
    console.error('[automation] 派发失败:', (err as Error).message);
    return [];
  }
}

/**
 * 统一规则失败日志（T6，2026-10-31 复核）。
 *
 * 各事件源（hub sink / time fire）消费 dispatchAutomationEvent 返回的 outcomes 时共用：
 * 「哪条规则、为什么失败」必须可见 —— 曾经 time 源只 .catch 派发异常，
 * 规则级失败（工具报错、abort 等）被静默丢弃，正是"配了没反应"的又一变体。
 *
 * 日志格式与 hub sink 原有格式一致（单一实现 ⇒ 两个源必然同格式）。
 * 不抛错：日志失败不能反过来拖垮事件源。
 */
export function warnFailedOutcomes(
  warn: (message: string, context?: Record<string, unknown>) => void,
  outcomes: readonly RuleRunOutcome[],
): void {
  if (!outcomes || outcomes.length === 0) return;
  const failed = outcomes.filter((o) => !o.result.ok);
  if (failed.length === 0) return;
  try {
    warn('自动化规则执行失败', {
      failed: failed.map((f) => ({ rule: f.ruleName, id: f.ruleId, error: f.result.error })),
    });
  } catch {
    // 日志管道坏了不该拖垮派发循环
  }
}

/**
 * maxRuns：成功执行后累加 runCount；达到上限自动停用（enabled=false）并落盘。
 *
 * ⚠️ 停用只改内存 + 写盘；probe watcher 不会立即 disarm（要等下次 reloadAndArm），
 *    但 ruleMatches 会过滤 enabled=false ⇒ 停用规则不再执行；time 规则由 timeSource
 *    检查 enabled 自动跳过。故无需在这里动 watcher，落盘即可持久化。
 */
function applyMaxRuns(outcomes: RuleRunOutcome[]): void {
  if (!outcomes || outcomes.length === 0) return;
  const rules = getCurrentAutomationRules();
  let dirty = false;
  for (const o of outcomes) {
    if (!o.result.ok) continue; // 只计成功轮次
    const r = rules.find((x) => x.id === o.ruleId);
    if (!r || r.maxRuns === undefined) continue;
    const next = (r.runCount ?? 0) + 1;
    r.runCount = next;
    if (next >= r.maxRuns) {
      r.enabled = false;
      console.error(`[automation] 规则 "${r.name}"(${r.id}) 已达 maxRuns=${r.maxRuns}，自动停用`);
    }
    dirty = true;
  }
  if (dirty) {
    try {
      saveAutomationRules(rules);
    } catch (err) {
      console.error('[automation] 更新 runCount 落盘失败:', (err as Error).message);
    }
  }
}

/**
 * 供 watch 等事件源调用的便捷入口：只要 kind 和 watchId，自动拼事件名。
 *
 * 事件名形态 `afterWatch:<kind>#<watchId>`：带 watchId 才能让 probe 类规则
 * **精确匹配自己 arm 的那个监控项**（同一 kind 下可能有多个监控，只按 kind
 * 匹配会让 A 的命中触发 B 的规则）。
 */
export async function dispatchWatchEvent(
  kind: string,
  watchId: string,
  payload?: Record<string, unknown>,
): Promise<RuleRunOutcome[]> {
  return dispatchAutomationEvent({
    eventName: `afterWatch:${kind}#${watchId}`,
    source: 'watch',
    name: watchId,
    at: Date.now(),
    payload: { kind, watchId, ...(payload ?? {}) },
  });
}
