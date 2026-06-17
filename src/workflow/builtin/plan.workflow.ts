/**
 * Plan Workflow — 框架驱动的文件持久化任务执行。
 *
 * 这是内置 Workflow 的**参考实现**。如果你要开发新的 Workflow，
 * 可以复制此文件的结构，替换自定义逻辑即可。
 *
 * ## 模式
 *
 *   analyze phase → 注入 modes/plan 模板引导，模型用 write 创建 plan.md
 *   execute phase → plan.md 进度 + 仅当前步骤，逐条驱动
 *   all done      → 框架自动停用
 *
 * ## 实现结构（= 新 Workflow 的模板）
 *
 *   ┌─ 内部类型          — data 结构（getData 辅助）
 *   ├─ 文件操作          — 读/写持久化文件
 *   ├─ createState       — 初始化，检测已有文件直接进 execute
 *   ├─ handleStep        — switch(action) { complete, progress/note, add, done/blocked }
 *   │    ├─ 阶段守卫      — 分析阶段拒绝步骤操作
 *   │    ├─ 共享工具      — parseSimpleSteps, markStepInFile, buildWfSteps
 *   │    └─ 自定义逻辑    — phase transition, prompt template
 *   ├─ renderPersistent  — 分析阶段=引导模板，执行阶段=进度摘要
 *   ├─ renderStep        — 仅当前步骤，非执行阶段返回空
 *   └─ isComplete        — 全部 [x] 才算完成
 *
 * ## 文件结构
 *
 *   ~/.agent/workflows/plan/<slug>/plan.md
 *
 * plan.md 是唯一真相源：步骤的创建、标记、完成全部写回文件。
 * createState 不写模板文件——文件由模型按注入的引导模板自行创建。
 */

// 这是一个新 Workflow 的参考实现。关键部分用 【自定义】 标注你需要修改的地方。

import type { WorkflowDefinition, WorkflowState } from '../types.js';
import { loadPrompt, renderPrompt } from '../../prompts/loader.js';
import {
  parseSimpleSteps, markStepInFile, allStepsDone,
  buildWfSteps, findNextStepIdx, findInProgressId, renderProgress,
} from '../shared/file-steps.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── 内部类型 ───────────────────────────────────────────────────────

interface PlanData { task: string; planDir: string; phase: 'analyze' | 'execute'; }

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
      const planDir = path.join(os.homedir(), '.agent', 'workflows', 'plan', taskSlug);
      if (!fs.existsSync(planDir)) fs.mkdirSync(planDir, { recursive: true });

      const content = readPlanFile(planDir);
      const parsedSteps = parseSimpleSteps(content);
      const hasSteps = parsedSteps.length > 0;
      const initialPhase: PlanData['phase'] = hasSteps ? 'execute' : 'analyze';

      return {
        name: 'plan',
        data: { task, planDir, phase: initialPhase } as unknown as Record<string, unknown>,
        steps: buildWfSteps(parsedSteps),
        startedAt: new Date().toISOString(),
      };
    },

    handleStep(state, action) {
      const { task, planDir, phase } = getData(state);
      const planPath = path.join(planDir, 'plan.md');
      const reject = (msg: string) => ({
        newState: state,
        result: { workflow: 'plan' as const, progress: msg, allDone: false },
      });

      switch (action.action) {
        case 'complete': {
          if (phase !== 'analyze') {
            return reject('✅ Plan workflow marked complete.');
          }

          const content = readPlanFile(planDir);
          if (!content.trim()) return reject('错误：plan.md 不存在或为空。请先用 write 创建。');
          const steps = parseSimpleSteps(content);
          if (steps.length === 0) return reject('错误：plan.md 中没有检测到步骤（格式: - [ ] 描述）。');

          const newPhase = 'execute' as const;
          const wfSteps = buildWfSteps(steps);
          const first = wfSteps.find(s => s.status === 'in_progress');

          return {
            newState: { ...state, phase: newPhase, data: { ...state.data, phase: newPhase } as unknown as Record<string, unknown>, steps: wfSteps },
            result: {
              workflow: 'plan',
              progress: `✅ 分析完成，进入执行阶段。解析到 ${steps.length} 个步骤:\n` +
                steps.map((s, i) => `  ${i + 1}. ${s.done ? '✅' : s.blocked ? '🚫' : '⬜'} ${s.text}`).join('\n'),
              allDone: false,
              nextStep: first,
            },
          };
        }

        case 'progress':
        case 'note':
          return reject(action.message ?? (action.action === 'progress' ? 'Progress noted.' : ''));

        case 'add': {
          if (phase === 'analyze') return reject('当前处于分析阶段，请用 write 编辑 plan.md，完成后调用 complete。');

          const desc = action.description ?? 'New step';
          let content: string;
          try { content = fs.readFileSync(planPath, 'utf-8'); } catch { content = `# Plan: ${task}\n\n`; }
          writePlanFile(planDir, content + `\n- [ ] ${desc}`);
          const updated = parseSimpleSteps(content + `\n- [ ] ${desc}`);
          const inProgress = findInProgressId(state.steps ?? []);

          return {
            newState: { ...state, steps: buildWfSteps(updated, inProgress) },
            result: { workflow: 'plan', progress: `✅ 已添加步骤: ${desc}`, allDone: false },
          };
        }

        case 'done':
        case 'blocked': {
          if (phase === 'analyze') return reject('当前处于分析阶段，请先用 write 编辑 plan.md，完成后调用 complete。');

          const id = action.id ?? 0;
          if (id < 1) return null;

          let content: string;
          try { content = fs.readFileSync(planPath, 'utf-8'); } catch { return null; }

          const steps = parseSimpleSteps(content);
          if (id > steps.length) return reject(`错误：步骤 ${id} 不存在。当前共 ${steps.length} 个步骤。`);

          const mark = action.action === 'done' ? 'x' as const : '🚫' as const;
          const newContent = markStepInFile(content, id - 1, mark, action.message);
          writePlanFile(planDir, newContent);

          const updated = parseSimpleSteps(newContent);
          const blocked = action.action === 'blocked';

          if (blocked) {
            const nextIdx = findNextStepIdx(updated, id);
            return {
              newState: { ...state, steps: buildWfSteps(updated, nextIdx) },
              result: {
                workflow: 'plan',
                progress: `🚫 步骤 ${id} 已标记为受阻: ${updated[id - 1].text}` +
                  (nextIdx !== -1 ? `\n自动进入步骤 ${nextIdx + 1}` : ''),
                allDone: false,
                nextStep: nextIdx !== -1 ? { id: nextIdx + 1, name: updated[nextIdx].text, description: updated[nextIdx].text, status: 'in_progress' } : undefined,
              },
            };
          }

          const completed = allStepsDone(updated);
          const nextIdx = findNextStepIdx(updated, id);

          return {
            newState: { ...state, steps: buildWfSteps(updated, nextIdx) },
            result: {
              workflow: 'plan',
              progress: completed
                ? `✅ 全部 ${updated.length} 个步骤已完成。`
                : nextIdx === -1
                  ? `✅ 步骤 ${id} 完成。受阻步骤需解除后可继续。`
                  : `✅ 步骤 ${id} 完成。\n下一步: 步骤 ${nextIdx + 1} — ${updated[nextIdx].text}`,
              allDone: completed,
              nextStep: !completed && nextIdx !== -1
                ? { id: nextIdx + 1, name: updated[nextIdx].text, description: updated[nextIdx].text, status: 'in_progress' }
                : undefined,
            },
          };
        }

        default: return null;
      }
    },

    renderForInjection(state) { return this.renderPersistent!(state); },

    renderPersistent(state) {
      const { task, planDir, phase } = getData(state);
      if (phase === 'analyze') {
        const content = readPlanFile(planDir);
        const template = loadPrompt('modes/plan');
        return renderPrompt(template, {
          task: task || '(未指定)',
          planPath: path.join(planDir, 'plan.md'),
          content: content || '(尚未创建 — 用 write 创建 plan.md，格式: - [ ] 描述)',
          currentStep: content ? '分析完成，检查 plan.md 确认无误后继续。' : '尚未创建',
          progress: '',
        });
      }

      const steps = parseSimpleSteps(readPlanFile(planDir));
      const progressLine = renderProgress(
        steps.filter(s => s.done).length, steps.length,
        steps.filter(s => s.blocked).length,
      );
      return `## Plan: ${task}\n\n**文件**: ${path.join(planDir, 'plan.md')}\n${progressLine}`;
    },

    renderStep(state) {
      const { planDir, phase } = getData(state);
      if (phase !== 'execute') return '';

      const steps = parseSimpleSteps(readPlanFile(planDir));
      const wfSteps = state.steps ?? [];
      const cur = wfSteps.find(s => s.status === 'in_progress');
      const blocked = steps.filter(s => s.blocked).length;

      if (allStepsDone(steps)) return '\n✅ All steps complete.';
      if (!cur) {
        const next = wfSteps.find(s => s.status === 'pending');
        if (next) return `\n### Next Step\n🔄 **${next.id}. ${next.description}**\n\nExecute: \`workflow({action:"step", id:${next.id}, stepAction:"done"})\``;
        if (blocked) return '\n⚠️ All remaining steps are blocked.';
        return '\nUse `workflow add` to add steps.';
      }

      return `\n### Current Step (${cur.id}/${steps.length})\n🔄 **${cur.description}**\n\nExecute now:\n\`\`\`\nworkflow({action:"step", id:${cur.id}, stepAction:"done"})\n\`\`\`\nIf blocked: \`workflow({action:"step", id:${cur.id}, stepAction:"blocked", message:"reason"})\``;
    },

    isComplete(state) {
      const content = readPlanFile(getData(state).planDir);
      if (!content.trim()) return false;
      return allStepsDone(parseSimpleSteps(content));
    },
  };
}
