/**
 * Automation 工具面（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 这一层解决什么
 * ────────────────────────────────────────────────────────────────────────────
 * 前面所有模块（types/validate/store/runner/runtime/sources）都是"能力"，
 * 但**模型没法用** —— 它不能手写 `~/.agent/automations.json`。
 * 这里给模型三个工具，把"设计链路"变成可操作的动作：
 *
 *   automation_validate  校验一条规则（**纯静态，不落盘、不执行**）
 *   automation_create    校验通过后保存（**默认 enabled=false**，需显式启用）
 *   automation_list      列出当前规则 + 运行状态
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 安全约束（这是有意的，别放宽）
 * ────────────────────────────────────────────────────────────────────────────
 * 1. `create` **必须先过校验**，任一错误即拒绝落盘 —— 模型能写链路 = 模型能造
 *    自动化破坏，一个笔误就可能反复触发错误动作。
 * 2. 新建的规则 **enabled 默认 false**：模型生成 ≠ 立即生效。要显式启用。
 * 3. `safety: critical` 类工具暂不在此放行（将来需要人类确认流程）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么依赖靠注入
 * ────────────────────────────────────────────────────────────────────────────
 * 校验要"已知知识"（probe kinds / tool names / handlers / events）、
 * 保存后要触发热重（重新加载 + 重新 arm watcher）。
 * 这些都在上层，本模块只声明需要什么，由装配层提供。
 */

import type { Tool } from '../tools/interface.js';
import type { AutomationRule } from './types.js';
import type { ValidationContext } from './validate.js';
import { validateRule } from './validate.js';

export interface AutomationToolDeps {
  /** 校验所需知识（每次现取，热更后自动跟上） */
  getContext: () => ValidationContext;
  /** 当前生效规则 */
  getRules: () => AutomationRule[];
  /**
   * 保存并重新加载（含重新 arm watcher）。
   * @returns 生效条数与逐条错误
   */
  save: (rules: AutomationRule[]) => { count: number; errors: string[] };
}

/** 把校验错误渲染成便于模型阅读的文本 */
function formatErrors(errors: string[]): string {
  return errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
}

export function createAutomationTools(deps: AutomationToolDeps): Tool[] {
  const validateTool: Tool = {
    name: 'automation_validate',
    description:
      '校验一条自动化链路规则（纯静态检查，不保存、不执行）。\n' +
      '会检查：结构是否完整、probe 类型是否存在、工具是否已注册、事件名是否在目录里、\n' +
      'wake 的 reuse 是否指定了会话、gate/loop 嵌套是否过深等。\n' +
      '**建议先用它验证，再用 automation_create 保存。**',
    inputSchema: {
      type: 'object',
      properties: {
        rule: {
          type: 'object',
          description:
            '规则对象。形如 { id, name, enabled, when: {kind:"probe",probe:{kind,spec}}, do:[...] }。\n' +
            'when.kind 可选 time/probe/event；do 里的 sink 可选 invoke/wake/gate/safety/loop。\n' +
            '**append 不可用**：append 处理器依赖工具执行上下文，automation 事件不带，恒返回空串\n' +
            '（写文件等用 invoke；append 类联动请用 tool-links 清单）。',
        },
      },
      required: ['rule'],
    },
    sideEffect: 'read',
    async execute(args: Record<string, unknown>): Promise<string> {
      const result = validateRule(args.rule, deps.getContext());
      if (result.errors.length === 0 && result.rule) {
        return [
          '✅ 校验通过',
          `  规则: ${result.rule.name} (${result.rule.id})`,
          `  触发: ${result.rule.when.kind}`,
          `  动作数: ${result.rule.do.length}`,
          result.rule.enabled ? '  ⚠️ enabled=true（将立即生效）' : '  enabled=false（保存后需显式启用）',
        ].join('\n');
      }
      return `❌ 校验失败（${result.errors.length} 处）:\n${formatErrors(result.errors)}`;
    },
  };

  const createTool: Tool = {
    name: 'automation_create',
    description:
      '创建/更新一条自动化链路规则。**先校验，通过才保存**；任何错误都会拒绝落盘。\n' +
      '新建规则默认 enabled=false —— 需要单独启用来避免"生成即生效"造成的意外。\n' +
      '保存后会立即重新加载（含重新启动 probe 监控）。',
    inputSchema: {
      type: 'object',
      properties: {
        rule: { type: 'object', description: '规则对象（同 automation_validate）' },
        enable: {
          type: 'boolean',
          description: '是否立即启用。默认 false（推荐先 false，确认无误再启用）。',
        },
        replace: {
          type: 'boolean',
          description: '同 id 已存在时是否覆盖。默认 true。',
        },
      },
      required: ['rule'],
    },
    sideEffect: 'write',
    async execute(args: Record<string, unknown>): Promise<string> {
      const ctx = deps.getContext();
      const result = validateRule(args.rule, ctx);
      if (!result.rule) {
        return `❌ 拒绝保存（校验未通过，${result.errors.length} 处）:\n${formatErrors(result.errors)}`;
      }

      const rule = result.rule;
      // 默认不启用：模型生成 ≠ 立即生效
      rule.enabled = args.enable === true;

      const existing = deps.getRules();
      const idx = existing.findIndex((r) => r.id === rule.id);
      const replace = args.replace !== false;

      if (idx >= 0 && !replace) {
        return `❌ 规则 id "${rule.id}" 已存在（如需覆盖请传 replace: true）`;
      }

      const next = idx >= 0 ? existing.map((r, i) => (i === idx ? rule : r)) : [...existing, rule];

      const saved = deps.save(next);
      const lines = [
        idx >= 0 ? `✅ 已更新规则: ${rule.name} (${rule.id})` : `✅ 已创建规则: ${rule.name} (${rule.id})`,
        `  触发: ${rule.when.kind}`,
        `  动作数: ${rule.do.length}`,
        `  启用: ${rule.enabled ? '是（已生效）' : '否（用 enable: true 或到 UI 启用）'}`,
        `  当前规则总数: ${saved.count}`,
      ];
      if (saved.errors.length > 0) {
        lines.push(`  ⚠️ 加载时发现 ${saved.errors.length} 处问题:\n${formatErrors(saved.errors)}`);
      }
      return lines.join('\n');
    },
  };

  const listTool: Tool = {
    name: 'automation_list',
    description: '列出当前所有自动化链路规则（含触发方式、动作数、启用状态）。',
    inputSchema: { type: 'object', properties: {} },
    sideEffect: 'read',
    async execute(): Promise<string> {
      const rules = deps.getRules();
      if (rules.length === 0) {
        return '当前没有自动化规则。\n可用 automation_create 创建，例如：监控进程退出后说一句话。';
      }
      const lines = [`=== 自动化规则 (${rules.length}) ===`];
      for (const r of rules) {
        const w = r.when;
        const trigger =
          w.kind === 'probe'
            ? `probe:${w.probe.kind} ${JSON.stringify(w.probe.spec)}`
            : w.kind === 'event'
              ? `event:${w.event}`
              : `time:${JSON.stringify(w.schedule)}`;
        lines.push(
          '',
          `  ${r.name} (${r.id})`,
          `    触发: ${trigger}`,
          `    动作: ${r.do.map((a) => a.sink).join(' → ')}`,
          `    状态: ${r.enabled ? 'enabled' : 'disabled'}`,
        );
      }
      return lines.join('\n');
    },
  };

  const removeTool: Tool = {
    name: 'automation_remove',
    description: '删除一条自动化规则（按 id）。保存后立即重新加载 + 重新 arm 其余规则。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的规则 id（用 automation_list 查看）' },
      },
      required: ['id'],
    },
    sideEffect: 'write',
    async execute(args: Record<string, unknown>): Promise<string> {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return '❌ 缺少 "id"（用 automation_list 查看规则 id）';
      const existing = deps.getRules();
      const removed = existing.find((r) => r.id === id);
      if (!removed) {
        return `❌ 没有 id="${id}" 的规则（用 automation_list 查看现有 id）`;
      }
      const next = existing.filter((r) => r.id !== id);
      const saved = deps.save(next);
      const lines = [
        `✅ 已删除规则: ${removed.name} (${id})`,
        `  剩余规则: ${saved.count}`,
      ];
      if (saved.errors.length > 0) {
        lines.push(`  ⚠️ 重新加载时发现 ${saved.errors.length} 处问题:\n${formatErrors(saved.errors)}`);
      }
      return lines.join('\n');
    },
  };

  return [validateTool, createTool, listTool, removeTool];
}
