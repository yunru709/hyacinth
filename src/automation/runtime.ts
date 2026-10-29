/**
 * AutomationRule 运行时（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 职责：**事件 → 找出匹配的规则 → 逐条执行**
 * ────────────────────────────────────────────────────────────────────────────
 * 这是"链路定义"变成"实际动作"的那一步，也是 TriggerHub 收敛点①的雏形：
 * 所有触发源都往这里投事件，本模块按规则表路由到 runner。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 事件命名约定（关键，别乱改）
 * ────────────────────────────────────────────────────────────────────────────
 *   afterWatch:<kind>        watch 监控命中（kind = file/http/process/port/ui_region）
 *   afterWatch:<kind>#<id>   同上，但带监控项 id（用于精确匹配某一条规则的 probe）
 *   afterScheduleTask        定时任务触发
 *   <loopHook>               工具/回合钩子（afterToolExecute、onTurnEnd…）
 *
 * 为什么 probe 规则用 `#id` 后缀：同一 kind 下可能同时存在多个监控项
 * （监控 A 日志 和 监控 B 日志 都是 file），只按 kind 匹配会让 A 的命中
 * 触发 B 的规则 —— 这在自动化里是灾难。所以要能精确定位到"哪个监控项"。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 失败隔离（与 tool-links 一致）
 * ────────────────────────────────────────────────────────────────────────────
 * 一条规则失败不影响其它规则；本函数**不抛错**（事件源多是后台循环）。
 * 每条规则的执行结果都通过 record 回调留痕（收敛点③）。
 */

import type { RuleEvent, RunnerContext, RunResult } from './runner.js';
import { runRule } from './runner.js';
import type { AutomationRule } from './types.js';

/** 运行时事件：在 RuleEvent 基础上加事件名（用于匹配） */
export interface AutomationEvent extends RuleEvent {
  /** 事件名，如 `afterWatch:process` / `afterWatch:process#w1` / `afterToolExecute:write` */
  eventName: string;
}

export interface RuleRunOutcome {
  ruleId: string;
  ruleName: string;
  result: RunResult;
}

/**
 * 规则是否匹配该事件。
 *
 * @param armedWatchIds 规则 arm 时登记的 watchId 映射（ruleId → watchId），
 *        probe 类规则靠它做精确匹配；未提供时退化为按 kind 宽松匹配（并计数告警）
 */
export function ruleMatches(
  rule: AutomationRule,
  event: AutomationEvent,
  armedWatchIds?: ReadonlyMap<string, string>,
): boolean {
  if (!rule.enabled) return false;
  const w = rule.when;

  if (w.kind === 'event') {
    // 允许写前缀：'afterWatch' 覆盖 'afterWatch:process'
    return event.eventName === w.event || event.eventName.startsWith(`${w.event}:`);
  }

  if (w.kind === 'probe') {
    const expectedKind = `afterWatch:${w.probe.kind}`;
    // 带 #id 的事件：精确比对本规则 arm 的那个 watchId
    if (event.eventName.includes('#')) {
      const watchId = armedWatchIds?.get(rule.id);
      if (!watchId) return false; // 规则没 arm 过，不该被任何带 id 的事件触发
      return event.eventName === `${expectedKind}#${watchId}`;
    }
    // 不带 id 的宽松事件：仅在不做精确匹配时兜底（批量/测试场景）
    return event.eventName === expectedKind;
  }

  // time 类由时间源以 `afterTime:<ruleId>` 形式投递
  return event.eventName === `afterTime:${rule.id}`;
}

/** 找出所有匹配的规则（保持规则表顺序 = 执行顺序） */
export function matchRules(
  rules: readonly AutomationRule[],
  event: AutomationEvent,
  armedWatchIds?: ReadonlyMap<string, string>,
): AutomationRule[] {
  return rules.filter((r) => ruleMatches(r, event, armedWatchIds));
}

/**
 * 执行所有匹配的规则。
 *
 * 失败隔离：单条规则抛错只影响它自己（runRule 内部已兜底，这里再包一层防编程错误）。
 */
export async function runMatchingRules(
  rules: readonly AutomationRule[],
  event: AutomationEvent,
  ctx: RunnerContext,
  armedWatchIds?: ReadonlyMap<string, string>,
): Promise<RuleRunOutcome[]> {
  const matched = matchRules(rules, event, armedWatchIds);
  if (matched.length === 0) return [];

  const outcomes: RuleRunOutcome[] = [];
  for (const rule of matched) {
    try {
      const result = await runRule(rule, event, ctx);
      outcomes.push({ ruleId: rule.id, ruleName: rule.name, result });
    } catch (err) {
      // runRule 理论上不抛；真抛了说明是编程错误，记下来但不拖垮其它规则
      const msg = (err as Error).message;
      console.error(`[automation] 规则 "${rule.name}"(${rule.id}) 执行异常: ${msg}`);
      outcomes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        result: { ok: false, steps: [], error: msg },
      });
    }
  }
  return outcomes;
}
