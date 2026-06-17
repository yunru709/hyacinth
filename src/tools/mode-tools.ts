/**
 * 模式系统统一工具 — mode_mark
 *
 * 一个工具覆盖 Plan / Spec 模式的文件创建与步骤标记。
 * action:
 *   init    — 创建文件，写入内容；返回路径和解析后的步骤数
 *   done    — 标记步骤完成（改文件），返回下一步
 *   blocked — 标记步骤受阻
 */

import type { Tool } from './interface.js';
import type { ModeManager } from '../modes/manager.js';
import type { WorkflowManager } from '../workflow/manager.js';
import fs from 'node:fs';
import path from 'node:path';

// ── 文件操作辅助 ────────────────────────────────────────────────

interface FileTarget {
  filePath: string;
  label: string; // 用于返回消息
}

function getTargetFile(modeManager: ModeManager): FileTarget | null {
  const mode = modeManager.getActive();
  const state = modeManager.getState();
  if (!mode || !state) return null;

  const data = state.data as Record<string, unknown>;

  switch (mode) {
    case 'plan':
      return {
        filePath: path.join(data.planDir as string, 'plan.md'),
        label: 'plan.md',
      };
    case 'spec': {
      const specDir = data.specDir as string;
      const phase = data.phase as string;
      if (phase === 'spec') return { filePath: path.join(specDir, 'spec.md'), label: 'spec.md' };
      if (phase === 'tasks') return { filePath: path.join(specDir, 'tasks.md'), label: 'tasks.md' };
      if (phase === 'checklist') return { filePath: path.join(specDir, 'checklist.md'), label: 'checklist.md' };
      return null;
    }
    default:
      return null;
  }
}

/** 解析 "- [ ] 描述" 行，返回步骤列表 */
function parseSteps(content: string): Array<{ lineIdx: number; text: string; done: boolean }> {
  const steps: Array<{ lineIdx: number; text: string; done: boolean }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[(.)\] (.+)/);
    if (m) {
      steps.push({ lineIdx: i, text: m[2].trim(), done: m[1] !== ' ' });
    }
  }
  return steps;
}

/** 标记指定步骤为 done 或 blocked，写回文件 */
function markStepInFile(
  content: string,
  stepIdx: number,
  mark: 'x' | '🚫',
  message?: string,
): string {
  const lines = content.split('\n');
  const step = parseSteps(content)[stepIdx];
  if (!step) return content;

  let suffix = '';
  if (mark === '🚫' && message) suffix = ` (受阻: ${message})`;

  lines[step.lineIdx] = lines[step.lineIdx].replace(/^- \[.\] (.+)/, `- [${mark}] $1${suffix}`);
  return lines.join('\n');
}

/** 创建模板文件 */
function createTemplateFiles(
  mode: string,
  modeManager: ModeManager,
  args: Record<string, unknown>,
): string {
  const state = modeManager.getState();
  if (!state) return '错误：模式状态未找到。';
  const data = state.data as Record<string, unknown>;

  if (mode === 'plan') {
    const planDir = data.planDir as string;
    const task = data.task as string;
    const content = (args.content as string) || `# Plan: ${task}\n\n- [ ] 步骤1\n- [ ] 步骤2\n- [ ] 步骤3\n`;
    fs.writeFileSync(path.join(planDir, 'plan.md'), content, 'utf-8');
    const steps = parseSteps(content);
    return `📁 plan.md 已创建到 ${planDir}/\n` +
      `已识别 ${steps.length} 个步骤:\n` +
      steps.map((s, i) => `  ${i + 1}. ${s.done ? '(已完成) ' : ''}${s.text}`).join('\n') +
      `\n\n开始执行第 1 步。如需修改步骤，用 write 编辑 plan.md。`;
  }

  if (mode === 'spec') {
    const specDir = data.specDir as string;
    const task = data.task as string;
    const specContent = (args.spec as string) || `# Spec: ${task}\n\n## 需求分析\n\n## 技术方案\n`;
    const tasksContent = (args.tasks as string) || `- [ ] 步骤1\n- [ ] 步骤2\n`;
    const checklistContent = (args.checklist as string) || `- [ ] 核心功能正常\n- [ ] 异常输入处理\n`;

    fs.writeFileSync(path.join(specDir, 'spec.md'), specContent, 'utf-8');
    fs.writeFileSync(path.join(specDir, 'tasks.md'), tasksContent, 'utf-8');
    fs.writeFileSync(path.join(specDir, 'checklist.md'), checklistContent, 'utf-8');

    const tasksSteps = parseSteps(tasksContent);
    return `📁 3 个文件已创建到 ${specDir}/\n` +
      `Phase 1 — 当前阶段: spec（收集需求，用 write 编辑 spec.md）\n` +
      `完成后调用 mode_mark({action:"done", id:0}) 进入 Phase 2\n` +
      `tasks.md 已识别 ${tasksSteps.length} 个执行步骤。`;
  }

  return `错误：模式 "${mode}" 不支持 init。`;
}

// ── 工具定义 ──────────────────────────────────────────────────────

export function createModeMarkTool(modeManager: ModeManager, workflowManager?: WorkflowManager): Tool {
  return {
    name: 'mode_mark',
    description:
      'Manage Plan/Spec/TODO modes. Actions: init (create plan/spec files), done (mark step complete), blocked (mark step blocked).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string' as const, enum: ['init', 'done', 'blocked'], description: '操作类型' },
        // init 参数
        content: { type: 'string' as const, description: 'Plan 模式的 plan.md 全文（init 时使用）' },
        spec: { type: 'string' as const, description: 'Spec 模式的 spec.md 全文（init 时使用）' },
        tasks: { type: 'string' as const, description: 'Spec 模式的 tasks.md 步骤列表（init 时使用）' },
        checklist: { type: 'string' as const, description: 'Spec 模式的 checklist.md 验收列表（init 时使用）' },
        // done / blocked 参数
        id: { type: 'number' as const, description: '步骤编号（1-based）。Spec Phase 1 结束时用 id:0' },
        message: { type: 'string' as const, description: 'blocked 时的受阻原因' },
      },
      required: ['action'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const action = args.action as string;
      const mode = modeManager.getActive();

      // ── Workflow routing ──────────────────────────────────────────
      if (workflowManager?.isActive() && (action === 'done' || action === 'blocked' || action === 'add')) {
        const result = workflowManager.dispatchStep({
          action: action as 'done' | 'blocked' | 'add',
          id: args.id as number | undefined,
          description: args.content as string | undefined,
          message: args.message as string | undefined,
        });
        if (result) {
          if (result.allDone) {
            workflowManager.deactivate();
            return `${result.progress}\n\nAll steps complete. Workflow finished.`;
          }
          return result.progress;
        }
      }

      // ── init ──────────────────────────────────────────────────────
      if (action === 'init') {
        if (!mode) return '当前没有激活 Plan 或 Spec 模式。如果你确实需要分步执行或规格化开发，告诉用户使用 /plan 或 /spec 命令。否则直接继续完成用户的任务即可，不需要调用 mode_mark。';
        return createTemplateFiles(mode, modeManager, args);
      }

      // ── done / blocked ────────────────────────────────────────────
      if (action === 'done' || action === 'blocked') {
        if (!mode) return '没有激活的模式。无需调用 mode_mark，继续当前工作即可。需要时让用户 /plan 或 /spec。';

        // Spec Phase 1 → Phase 2 特殊处理
        if (mode === 'spec' && action === 'done' && (args.id as number) === 0) {
          const state = modeManager.getState();
          if (!state) return '错误：状态未找到。';
          const data = state.data as Record<string, unknown>;
          if (data.phase !== 'spec') return '错误：当前不是 Spec Phase 1。';

          // 推进到 Phase 2
          const specDir = data.specDir as string;
          data.phase = 'tasks';
          const tasksPath = path.join(specDir, 'tasks.md');
          let tasksContent = '';
          try { tasksContent = fs.readFileSync(tasksPath, 'utf-8'); } catch { return '错误：tasks.md 未找到，请先创建。'; }

          const steps = parseSteps(tasksContent);
          if (steps.length === 0) return '错误：tasks.md 中没有检测到步骤（格式: - [ ] 描述）。';

          const tasks: Array<{ id: number; description: string; status: string }> = steps.map((s, i) => ({ id: i + 1, description: s.text, status: s.done ? 'completed' : 'pending' }));
          if (!steps[0].done) tasks[0].status = 'in_progress';
          (data as Record<string, unknown>).tasks = tasks;

          return `✅ Phase 1 完成，进入 Phase 2 执行阶段。\n` +
            `解析到 ${steps.length} 个步骤:\n` +
            steps.map((s, i) => `  ${i + 1}. ${s.done ? '✅' : '⬜'} ${s.text}`).join('\n') +
            `\n开始执行第 1 步。每步完成后调用 mode_mark({action:"done", id:N})。`;
        }

        // 常规 done / blocked
        const target = getTargetFile(modeManager);
        if (!target) return `错误：模式 "${mode}" 不支持此操作。`;

        let content: string;
        try { content = fs.readFileSync(target.filePath, 'utf-8'); } catch { return `错误：${target.label} 未找到。`; }

        const steps = parseSteps(content);
        const id = (args.id as number) ?? 0;
        if (id < 1 || id > steps.length) {
          return `错误：步骤 ${id} 不存在。当前共 ${steps.length} 个步骤（编号 1-${steps.length}）。`;
        }

        const mark = action === 'done' ? 'x' : '🚫';
        const newContent = markStepInFile(content, id - 1, mark as 'x' | '🚫', args.message as string);
        fs.writeFileSync(target.filePath, newContent, 'utf-8');

        const updatedSteps = parseSteps(newContent);
        const currentStep = updatedSteps[id - 1];

        if (action === 'blocked') {
          return `🚫 步骤 ${id} 已标记为受阻: ${currentStep.text}`;
        }

        // 找下一个未完成步骤
        const nextIdx = updatedSteps.findIndex((s, i) => i >= id && !s.done);
        if (nextIdx === -1) {
          // Spec Phase 2 (tasks) 全部完成 → 推进到 Phase 3 (checklist)
          const state = modeManager.getState();
          const data = state?.data as Record<string, unknown> | undefined;
          if (mode === 'spec' && data?.phase === 'tasks') {
            data.phase = 'checklist';
            const specDir = data.specDir as string;
            const clPath = path.join(specDir, 'checklist.md');
            let clContent = '';
            try { clContent = fs.readFileSync(clPath, 'utf-8'); } catch { return '错误：checklist.md 未找到。'; }
            const clSteps = parseSteps(clContent);
            if (clSteps.length === 0) return '错误：checklist.md 中没有检测到验收项。';
            return `✅ Phase 2 全部完成，进入 Phase 3 验收阶段。\n` +
              `解析到 ${clSteps.length} 个验收项:\n` +
              clSteps.map((s, i) => `  ${i + 1}. ${s.done ? '✅' : '⬜'} ${s.text}`).join('\n') +
              `\n逐项验证，每项完成后调用 mode_mark({action:"done", id:N})。`;
          }
          // 全部完成 → 自动结束
          modeManager.deactivate();
          return `✅ 全部 ${updatedSteps.length} 个步骤已完成。模式已自动结束。`;
        }

        return `✅ 步骤 ${id} 完成。\n下一步: 步骤 ${nextIdx + 1} — ${updatedSteps[nextIdx].text}`;
      }

      return `错误：未知 action "${action}"。支持: init | done | blocked。`;
    },
  };
}

// 保留 task_start / task_mark 向后兼容
export { createTaskStartTool, createTaskMarkTool } from './mode-tools-compat.js';
