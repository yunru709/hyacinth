// ============================================================
// Flow Tools — 通用流程控制工具
// ============================================================
//
// flow_start    — 激活指定模式（todo / plan / spec / ...）
// flow_add      — 向当前活跃 Flow 追加定义项（仅 definition 阶段有效）
// flow_complete — 完成当前步骤/阶段，触发 guard → 状态转移
//
// 这三个工具以 flow_ 为前缀，自成体系。新增模式时只需扩展
// flow_start 的 mode 枚举，不新增工具。
//
// Flow 工具不记入对话历史——状态由 Zone 5 注入体现。
// ============================================================

import type { Tool } from './interface.js';
import type { MachineRegistry } from '../machine/registry.js';

// ── 元数据 ──────────────────────────────────────────────────

/** Flow 框架工具名称集合 — 这些工具不记入对话历史 */
export const FLOW_TOOL_NAMES = new Set([
  'flow_start',
  'flow_add',
  'flow_complete',
]);

/** 已注册的 Flow mode → 描述映射 */
const MODE_DESCRIPTIONS: Record<string, string> = {
  todo: '任务拆分与逐步执行 — 分析任务 → 拆解步骤 → 逐个执行',
  spec: '需求规格撰写 — spec.md → tasks.md → checklist.md 三阶段推进',
};

/** 判断给定工具名是否为 Flow 框架工具 */
export function isFlowTool(name: string): boolean {
  return FLOW_TOOL_NAMES.has(name);
}

// ── flow_start ──────────────────────────────────────────────

export function createFlowStartTool(registry: MachineRegistry): Tool {
  return {
    name: 'flow_start',
    description:
      'Activate a guided workflow mode. Available modes:\n' +
      Object.entries(MODE_DESCRIPTIONS)
        .map(([k, v]) => `  - "${k}": ${v}`)
        .join('\n') +
      '\n\nAfter activation, use flow_add to define items and flow_complete to advance.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: `The workflow mode to activate. One of: ${Object.keys(MODE_DESCRIPTIONS).join(', ')}.`,
          enum: Object.keys(MODE_DESCRIPTIONS),
        },
        task: {
          type: 'string',
          description: 'A concise description of the overall task (for todo mode).',
        },
      },
      required: ['mode'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const mode = (args.mode as string) ?? '';
      const task = (args.task as string) ?? '';

      if (!MODE_DESCRIPTIONS[mode]) {
        return `Unknown mode "${mode}". Available: ${Object.keys(MODE_DESCRIPTIONS).join(', ')}.`;
      }

      const flow = registry.get(mode);
      if (!flow) {
        return `Flow for mode "${mode}" is not registered.`;
      }

      // 检查是否同一 Flow 已经处于活跃状态
      const currentActive = registry.getActive();
      if (currentActive?.id === mode) {
        const snap = currentActive.getSnapshot();
        const steps = (snap.context.steps as Array<{ id: string }> | undefined) ?? [];
        if (steps.length > 0) {
          return `Flow "${mode}" is already active with ${steps.length} step(s). Use flow_add to add more steps, or flow_complete to advance. To restart with a fresh plan, destroy the current flow first (wait for it to complete or be deactivated).`;
        }
        return `Flow "${mode}" is already active (no steps yet). Add steps with flow_add, then call flow_complete.`;
      }

      // 激活 Flow（自动停用当前活跃 Flow）
      registry.activate(mode, { task });

      return `Flow "${mode}" activated${task ? ` for task: "${task}"` : ''}. Follow the instructions in context, then call flow_complete to advance.`;
    },
  };
}

// ── flow_add ────────────────────────────────────────────────

export function createFlowAddTool(registry: MachineRegistry): Tool {
  return {
    name: 'flow_add',
    description:
      'Add steps to the current active flow. In todo mode, each step is an execution state. Submit ALL steps at once — do not add them one by one. Steps will be executed in order.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'ALL step descriptions at once. Each string is one step — a clear, actionable description of what to do and what success looks like. Submit the COMPLETE list in one call.',
        },
      },
      required: ['steps'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const active = registry.getActive();
      if (!active) {
        return 'No active flow. Use flow_start first.';
      }

      const stepDescs = (args.steps as string[]) ?? [];

      if (!active.addItem) {
        return `Flow "${active.id}" does not support adding items.`;
      }

      if (stepDescs.length === 0) {
        return 'No steps provided. Pass at least one step description in the steps array.';
      }

      const added: string[] = [];
      for (const desc of stepDescs) {
        const item = active.addItem(desc);
        added.push(`${item.id}: ${item.label}`);
      }

      // 规划阶段：写入步骤后自动转移到执行阶段
      // 模型只需提交步骤，状态机自己推进，无需模型额外调 flow_complete
      const snapAfter = active.getSnapshot();
      if (snapAfter.currentState === 'planning') {
        const advanceResult = active.advance('flow_complete');
        if (advanceResult.ok) {
          registry.onAdvanceSucceeded(active.id, advanceResult.isTerminal ?? false);
          const newSnap = active.getSnapshot();
          const newSteps = (newSnap.context.steps as Array<{ id: string; label: string }> | undefined) ?? [];
          const newIdx = (newSnap.context.stepIndex as number) ?? 0;
          const firstStep = newSteps[newIdx];
          if (firstStep) {
            return `${added.length} step(s) added. Auto-advanced to execution.\n\n${'-'.repeat(40)}\n${added.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}\n${'-'.repeat(40)}\n\nNow executing step ${newIdx + 1}/${newSteps.length}: "${firstStep.label}"`;
          }
          return `${added.length} step(s) added:\n${added.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}\n\nAuto-advanced to execution.`;
        }
        // guard 失败（比如步骤数为0），不自动转移，让模型知道
        return `${added.length} step(s) added:\n${added.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}\n\nWarning: could not auto-advance — ${advanceResult.reason ?? 'unknown guard failure'}. Call flow_complete manually.`;
      }

      return `${added.length} step(s) added:\n${added.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}\n\nAll steps defined. Call flow_complete to begin execution.`;
    },
  };
}

// ── flow_complete ───────────────────────────────────────────

export function createFlowCompleteTool(registry: MachineRegistry): Tool {
  return {
    name: 'flow_complete',
    description:
      'Complete the current flow step or phase and advance. In definition phase (todo planning), this finishes defining and starts execution. In execution phase, this advances to the next step. On the final step, the flow ends.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_args: Record<string, unknown>): Promise<string> {
      const active = registry.getActive();
      if (!active) {
        return 'No active flow. Nothing to complete.';
      }

      const snap = active.getSnapshot();
      const steps = (snap.context.steps as Array<{ id: string; label: string }> | undefined) ?? [];
      const idx = (snap.context.stepIndex as number) ?? 0;

      // 执行实际的状态转移（guard 检查在此发生）
      const result = active.advance('flow_complete');

      if (!result.ok) {
        // Guard 失败：返回失败原因给模型
        return `Cannot advance: ${result.reason ?? 'unknown guard failure'}`;
      }

      // 转移成功：更新 registry（terminal 则清理）
      registry.onAdvanceSucceeded(active.id, result.isTerminal ?? false);

      if (result.isTerminal) {
        return 'All steps completed. Flow finished.';
      }

      // 查找下一步
      const newSnap = active.getSnapshot();
      const newSteps = (newSnap.context.steps as Array<{ id: string; label: string }> | undefined) ?? [];
      const newIdx = (newSnap.context.stepIndex as number) ?? 0;
      const nextStep = newSteps[newIdx];

      if (newSnap.currentState === 'executing' && nextStep) {
        return `Planning complete (${newSteps.length} steps). Now executing step ${newIdx + 1}/${newSteps.length}: "${nextStep.label}"`;
      }
      if (nextStep) {
        return `Step "${nextStep.id}" (${newIdx + 1}/${newSteps.length}) acknowledged. Advancing to: "${nextStep.label}"`;
      }
      return `${newSteps.length} items defined — transitioning to execution.`;
    },
  };
}
