// ============================================================
// UI 契约层 — 自动化域（automation.*）
// ============================================================
// 让 WebUI 能读写 AutomationRule（触发 + 动作链），与后端 automation/
// 模块共用同一份规则文件（~/.agent/automations.json）。
//
// 为什么不复用 schedule 域：
//   schedule 的 action 是 {type:'scheduled', target}（=唤醒模型跑一轮），
//   而 AutomationRule 的 do 是**动作链**（invoke 调工具/参数、gate、wake）。
//   两者语义不同；硬塞进 schedule 会让 UI 无法表达"零模型 invoke 工具"
//   这类核心能力（那正是自动化相对定时任务的价值）。
//
// 依赖注入：本模块不认识 backend；工具名列表由装配层 getToolNames 提供，
// 用于构造 validate 的 ValidationContext（knownToolNames）。
// ============================================================

import type { DomainHandler } from '../server.js';
import type { AutomationRule } from '../../automation/types.js';
import { validateRule, type ValidationContext } from '../../automation/validate.js';
import {
  getCurrentAutomationRules,
  saveAutomationRules,
  initAutomationsFromDisk,
} from '../../automation/store.js';
import { armProbeRules, disarmWatchIds } from '../../automation/sources.js';
import { getAutomationRuntime, setAutomationRuntime } from '../../automation/service.js';
import { getWatchService } from '../../watch/service-instance.js';
import { DEFAULT_PROBE_KINDS } from '../../watch/probes/index.js';
import { LOOP_HOOK_NAMES } from '../../orchestrator/loop-hooks.js';
import { TOOL_LINK_EXTRA_EVENT_SOURCES } from '../../utils/tool-links.js';

export interface AutomationDomainOptions {
  /** 取当前已注册工具名（构造 ValidationContext 用；UI 侧从 backend.getToolRegistry 提供） */
  getToolNames: () => string[];
}

export function createAutomationDomain(options: AutomationDomainOptions): DomainHandler {
  const { getToolNames } = options;

  const makeCtx = (): ValidationContext => ({
    knownProbeKinds: DEFAULT_PROBE_KINDS,
    knownToolNames: getToolNames(),
    knownEvents: [...LOOP_HOOK_NAMES, ...TOOL_LINK_EXTRA_EVENT_SOURCES],
  });

  /**
   * 写盘 + 重新加载 + 重新 arm watcher。
   * 与 agent-assembly 的 reloadAndArm 同构 —— UI 改规则必须走它，否则 probe
   * watcher 不会重新挂载，新规则形同虚设（这是最容易踩的坑）。
   */
  function saveAndReload(rules: AutomationRule[]): { count: number; errors: string[] } {
    saveAutomationRules(rules);
    const watch = getWatchService() as unknown as Parameters<typeof armProbeRules>[1];
    const prev = getAutomationRuntime()?.armedWatchIds;
    if (prev && prev.size > 0) disarmWatchIds(watch, prev.values());
    const applied = initAutomationsFromDisk(makeCtx()); // 从刚写的盘重读（含逐条校验）
    const reArmed = armProbeRules(getCurrentAutomationRules(), watch);
    const cur = getAutomationRuntime();
    if (cur) setAutomationRuntime({ ...cur, armedWatchIds: reArmed.armed });
    return { count: applied.count, errors: [...applied.errors, ...reArmed.errors] };
  }

  return {
    // automation.list —— 列出当前规则（前端直接渲染触发/动作/启用）
    list() {
      return { rules: getCurrentAutomationRules() };
    },

    // automation.validate —— 纯校验（不落盘），前端可先验再存
    validate(params: unknown) {
      const rule = (params as { rule?: unknown } | undefined)?.rule;
      const r = validateRule(rule, makeCtx());
      return r.rule ? { ok: true, errors: [] as string[], rule: r.rule } : { ok: false, errors: r.errors };
    },

    // automation.create —— 校验通过才保存（enable/replace 语义同 automation_create 工具）
    create(params: unknown) {
      const p = (params ?? {}) as { rule?: unknown; enable?: boolean; replace?: boolean };
      const r = validateRule(p.rule, makeCtx());
      if (!r.rule) return { ok: false, errors: r.errors };
      const rule = r.rule;
      rule.enabled = p.enable === true;
      const existing = getCurrentAutomationRules();
      const idx = existing.findIndex((x) => x.id === rule.id);
      if (idx >= 0 && p.replace === false) {
        return { ok: false, errors: [`id "${rule.id}" 已存在（如需覆盖请 replace:true）`] };
      }
      const next = idx >= 0 ? existing.map((x, i) => (i === idx ? rule : x)) : [...existing, rule];
      const saved = saveAndReload(next);
      return { ok: true, count: saved.count, errors: saved.errors };
    },

    // automation.remove —— 删除并热更
    remove(params: unknown) {
      const id = (params as { id?: string } | undefined)?.id;
      if (!id) throw new Error('automation.remove requires "id"');
      const next = getCurrentAutomationRules().filter((x) => x.id !== id);
      const saved = saveAndReload(next);
      return { ok: true, count: saved.count, errors: saved.errors };
    },

    // automation.toggle —— 启用/禁用并热更
    toggle(params: unknown) {
      const p = (params ?? {}) as { id?: string; enabled?: boolean };
      if (!p.id || p.enabled === undefined) throw new Error('automation.toggle requires "id" and "enabled"');
      const enabled = p.enabled;
      const next = getCurrentAutomationRules().map((x) =>
        x.id === p.id ? ({ ...x, enabled } as AutomationRule) : x,
      );
      const saved = saveAndReload(next);
      return { ok: true, count: saved.count, errors: saved.errors };
    },
  };
}
