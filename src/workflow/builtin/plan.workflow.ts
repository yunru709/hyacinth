/**
 * Plan Workflow — 文件驱动，checkbox 步骤列表。
 *
 * 文件唯一真相源：~/.agent/plans/<slug>/plan.md
 * handleStep 负责读写 plan.md 并标记 checkbox。
 * 复用 plan.mode.ts 和 mode-tools.ts 的核心逻辑。
 */

import type { WorkflowDefinition, WorkflowState } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── 内部类型 ───────────────────────────────────────────────────────

interface PlanData { task: string; planDir: string; }

function getData(state: WorkflowState): PlanData {
  return state.data as unknown as PlanData;
}

// ─── 文件操作 ───────────────────────────────────────────────────────

function readPlanFile(planDir: string): string {
  try { return fs.readFileSync(path.join(planDir, 'plan.md'), 'utf-8'); } catch { return ''; }
}

function writePlanFile(planDir: string, content: string): void {
  fs.writeFileSync(path.join(planDir, 'plan.md'), content, 'utf-8');
}

/** 解析 "- [ ] 描述" 行，返回步骤列表 */
function parseSteps(content: string): Array<{ lineIdx: number; text: string; done: boolean }> {
  const steps: Array<{ lineIdx: number; text: string; done: boolean }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[(.)\] (.+)/);
    if (m) steps.push({ lineIdx: i, text: m[2].trim(), done: m[1] !== ' ' });
  }
  return steps;
}

/** 标记指定步骤为 done(x) 或 blocked(🚫)，写回文件 */
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

// ─── 工厂 ───────────────────────────────────────────────────────────

export function createPlanWorkflow(): WorkflowDefinition {
  return {
    name: 'plan',
    description: '计划执行模式 — 文件驱动的任务分解与逐步完成',
    source: 'builtin',
    relatedTools: ['read', 'write', 'edit', 'glob', 'grep'],
    triggerKeywords: ['plan', 'planning', 'break down', 'task list'],

    createState(params) {
      const task = String(params.task ?? '');
      const taskSlug = task.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-').slice(0, 60) || 'plan';
      const planDir = path.join(os.homedir(), '.agent', 'plans', taskSlug);
      if (!fs.existsSync(planDir)) fs.mkdirSync(planDir, { recursive: true });

      // 如果 plan.md 不存在，创建空模板
      const planPath = path.join(planDir, 'plan.md');
      if (!fs.existsSync(planPath)) {
        const template = `# Plan: ${task}\n\n- [ ] 步骤1\n- [ ] 步骤2\n- [ ] 步骤3\n`;
        fs.writeFileSync(planPath, template, 'utf-8');
      }

      const content = readPlanFile(planDir);
      const parsedSteps = parseSteps(content);

      return {
        name: 'plan',
        data: { task, planDir } as unknown as Record<string, unknown>,
        steps: parsedSteps.map((s, i) => ({
          id: i + 1,
          name: s.text,
          description: s.text,
          status: s.done ? 'completed' as const
            : (i === parsedSteps.findIndex(x => !x.done) ? 'in_progress' as const : 'pending' as const),
        })),
        startedAt: new Date().toISOString(),
      };
    },

    handleStep(state, action) {
      const { planDir } = getData(state);
      const planPath = path.join(planDir, 'plan.md');

      // ── init ────────────────────────────────────────────────────
      if (action.action === 'complete') {
        // "complete" 是全局完成标记
        return null;
      }

      if (action.action === 'progress' || action.action === 'note') {
        return null; // no state change for notes
      }

      // ── add ─────────────────────────────────────────────────────
      if (action.action === 'add') {
        const desc = action.description ?? 'New step';
        let content: string;
        try { content = fs.readFileSync(planPath, 'utf-8'); } catch {
          content = `# Plan: ${getData(state).task}\n\n`;
        }
        content += `\n- [ ] ${desc}`;
        writePlanFile(planDir, content);
        const updatedSteps = parseSteps(content);
        return {
          newState: {
            ...state,
            steps: updatedSteps.map((s, i) => ({
              id: i + 1,
              name: s.text,
              description: s.text,
              status: s.done ? 'completed' as const : 'pending' as const,
            })),
          },
          result: {
            workflow: 'plan',
            progress: `✅ 已添加步骤: ${desc}`,
            allDone: false,
          },
        };
      }

      // ── done / blocked ──────────────────────────────────────────
      if (action.action === 'done' || action.action === 'blocked') {
        const id = action.id ?? 0;
        if (id < 1) return null;

        let content: string;
        try { content = fs.readFileSync(planPath, 'utf-8'); } catch {
          return null;
        }

        const steps = parseSteps(content);
        if (id > steps.length) {
          return {
            newState: state,
            result: {
              workflow: 'plan',
              progress: `错误：步骤 ${id} 不存在。当前共 ${steps.length} 个步骤（编号 1-${steps.length}）。`,
              allDone: false,
            },
          };
        }

        const mark = action.action === 'done' ? 'x' : '🚫';
        const newContent = markStepInFile(content, id - 1, mark, action.message);
        writePlanFile(planDir, newContent);

        const updatedSteps = parseSteps(newContent);
        const currentStep = updatedSteps[id - 1];

        if (action.action === 'blocked') {
          return {
            newState: {
              ...state,
              steps: updatedSteps.map((s, i) => ({
                id: i + 1,
                name: s.text,
                description: s.text,
                status: s.done ? 'completed' as const : 'blocked' as const,
              })),
            },
            result: {
              workflow: 'plan',
              progress: `🚫 步骤 ${id} 已标记为受阻: ${currentStep.text}`,
              allDone: false,
            },
          };
        }

        // done: 找下一个未完成步骤
        const nextIdx = updatedSteps.findIndex((s, i) => i >= id && !s.done);
        const allCompleted = updatedSteps.length > 0 && updatedSteps.every(s => s.done);

        return {
          newState: {
            ...state,
            steps: updatedSteps.map((s, i) => ({
              id: i + 1,
              name: s.text,
              description: s.text,
              status: s.done ? 'completed' as const
                : (i === nextIdx ? 'in_progress' as const : 'pending' as const),
            })),
          },
          result: {
            workflow: 'plan',
            progress: allCompleted
              ? `✅ 全部 ${updatedSteps.length} 个步骤已完成。工作流已结束。`
              : nextIdx === -1
                ? `✅ 步骤 ${id} 完成。所有剩余步骤已完成。`
                : `✅ 步骤 ${id} 完成。\n下一步: 步骤 ${nextIdx + 1} — ${updatedSteps[nextIdx].text}`,
            allDone: allCompleted,
            nextStep: nextIdx !== -1 ? {
              id: nextIdx + 1,
              name: updatedSteps[nextIdx].text,
              description: updatedSteps[nextIdx].text,
              status: 'in_progress',
            } : undefined,
          },
        };
      }

      return null;
    },

    renderForInjection(state) {
      const { task, planDir } = getData(state);
      const content = readPlanFile(planDir);
      const steps = parseSteps(content);
      const next = steps.find(s => !s.done);
      const planPath = path.join(planDir, 'plan.md');

      const progress = steps.map((s, i) => {
        const mark = s.done ? '✅' : (s === next ? '🔄' : '⬜');
        return `  ${mark} [${i + 1}] ${s.text}`;
      }).join('\n');

      return `## Plan Workflow: ${task || '(未指定)'}

**文件**: ${planPath}

**进度**:
${progress || '(尚未创建 — 使用 workflow step add 添加步骤)'}

${next ? `🔄 当前: 步骤 ${steps.findIndex(s => !s.done) + 1} — ${next.text}` : (content ? '✅ 全部完成' : '')}

使用 \`workflow({action:"step", id:N, stepAction:"done"})\` 标记步骤完成。
使用 \`workflow({action:"step", stepAction:"add", description:"新步骤"})\` 添加步骤。`;
    },

    isComplete(state) {
      const content = readPlanFile(getData(state).planDir);
      if (!content.trim()) return false;
      const steps = parseSteps(content);
      return steps.length > 0 && steps.every(s => s.done);
    },
  };
}
