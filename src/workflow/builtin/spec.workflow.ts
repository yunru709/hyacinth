/**
 * Spec Workflow — 三阶段，三文档，文件驱动。
 *
 * 文件: ~/.agent/workflows/spec/<slug>/spec.md | tasks.md | checklist.md
 *
 * 三份文档：
 *   spec.md     — 需求分析、架构设计、技术方案（持久注入，贯穿全部阶段）
 *   tasks.md    — 多级任务分解（## 第N部分 → - [ ] 步骤），框架按段推进
 *   checklist.md — 验收清单，逐项对照 spec.md 验证
 *
 * 三阶段：
 *   Phase 1 (spec)      — 引导模型同时编写三份文档，完成后调用 complete
 *   Phase 2 (tasks)     — 解析 tasks.md 结构，逐条注入执行，spec.md 持续注入
 *   Phase 3 (checklist) — 解析 checklist.md，逐项验收，spec.md 持续注入
 */

import type { WorkflowDefinition, WorkflowState } from '../types.js';
import { loadPrompt, renderPrompt } from '../../prompts/loader.js';
import {
  parseSimpleSteps, parseTaskSections, flattenSections,
  markStepInFile, allStepsDone,
  buildWfSteps, buildWfStepsFromFlat,
  findNextStepIdx, findInProgressId, renderProgress,
} from '../shared/file-steps.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── 内部类型 ───────────────────────────────────────────────────────

interface SpecData {
  task: string;
  specDir: string;
  phase: 'spec' | 'tasks' | 'checklist';
}

function getData(state: WorkflowState): SpecData {
  return state.data as unknown as SpecData;
}

function getPhaseFile(phase: string): string {
  switch (phase) { case 'tasks': return 'tasks.md'; case 'checklist': return 'checklist.md'; default: return 'spec.md'; }
}

function readFile(specDir: string, name: string): string {
  try { return fs.readFileSync(path.join(specDir, name), 'utf-8'); } catch { return ''; }
}

function writeFile(specDir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(specDir, name), content, 'utf-8');
}

// ─── 工厂 ───────────────────────────────────────────────────────────

export function createSpecWorkflow(): WorkflowDefinition {
  return {
    name: 'spec',
    description: '规格化开发模式 — 三文档 × 三阶段：分析→执行→验收',
    source: 'builtin',
    relatedTools: ['read', 'write', 'edit', 'glob', 'grep'],
    triggerKeywords: ['spec', 'specification', 'requirement', 'design'],

    createState(params) {
      const task = String(params.task ?? '');
      const taskSlug = task.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-').slice(0, 60) || 'spec';
      const specDir = path.join(os.homedir(), '.agent', 'workflows', 'spec', taskSlug);
      if (!fs.existsSync(specDir)) fs.mkdirSync(specDir, { recursive: true });

      return {
        name: 'spec',
        phase: 'spec',
        data: { task, specDir, phase: 'spec' } as unknown as Record<string, unknown>,
        steps: [],
        startedAt: new Date().toISOString(),
      };
    },

    handleStep(state, action) {
      const data = getData(state);
      const { specDir, phase } = data;
      const reject = (msg: string) => ({
        newState: state,
        result: { workflow: 'spec' as const, phase, progress: msg, allDone: false },
      });
      const rejectPhase1 = () => reject(
        'Phase 1 (spec) 不接受步骤操作。请用 write 创建三份文档后调用 complete。',
      );

      switch (action.action) {
        case 'complete': {
          if (phase !== 'spec') return reject('✅ Spec phase marked complete.');

          const tasksContent = readFile(specDir, 'tasks.md');
          if (!tasksContent.trim()) return reject('错误：tasks.md 不存在或为空。');
          const sections = parseTaskSections(tasksContent);
          const flat = flattenSections(sections);
          if (flat.length === 0) return reject('错误：tasks.md 中没有步骤（格式: - [ ] 描述）。');
          if (!readFile(specDir, 'spec.md').trim()) return reject('错误：spec.md 不存在或为空。');
          if (!readFile(specDir, 'checklist.md').trim()) return reject('错误：checklist.md 不存在或为空。');

          const newPhase = 'tasks' as const;
          const wfSteps = buildWfStepsFromFlat(flat);
          const first = wfSteps.find(s => s.status === 'in_progress');
          const sectionList = sections.map(s => `  **${s.title}** (${s.steps.length} 步)`).join('\n');

          return {
            newState: { ...state, phase: newPhase, data: { ...state.data, phase: newPhase } as unknown as Record<string, unknown>, steps: wfSteps },
            result: {
              workflow: 'spec', phase: 'tasks',
              progress: `✅ Phase 1 完成，进入 Phase 2。\n${sections.length} 部分、${flat.length} 步骤:\n${sectionList}`,
              allDone: false, nextStep: first,
            },
          };
        }

        case 'progress':
        case 'note':
          return reject(action.message ?? (action.action === 'progress' ? 'Progress noted.' : ''));

        case 'add': {
          if (phase === 'spec') return rejectPhase1();
          const fileName = getPhaseFile(phase);
          let content = readFile(specDir, fileName);
          content += `\n- [ ] ${action.description ?? 'New step'}`;
          writeFile(specDir, fileName, content);
          const updated = parseSimpleSteps(content);
          return {
            newState: { ...state, steps: buildWfSteps(updated, findInProgressId(state.steps ?? [])) },
            result: { workflow: 'spec', phase, progress: `✅ 已添加到 ${fileName}`, allDone: false },
          };
        }

        case 'done':
        case 'blocked': {
          if (phase === 'spec') return rejectPhase1();

          const id = action.id ?? 0;
          if (id < 1) return null;

          const fileName = getPhaseFile(phase);
          let content: string;
          try { content = fs.readFileSync(path.join(specDir, fileName), 'utf-8'); } catch { return null; }

          const steps = parseSimpleSteps(content);
          if (id > steps.length) return reject(`错误：步骤 ${id} 不存在。${fileName} 共 ${steps.length} 步。`);

          const isBlocked = action.action === 'blocked';
          const newContent = markStepInFile(content, id - 1, isBlocked ? '🚫' : 'x', action.message);
          writeFile(specDir, fileName, newContent);
          const updated = parseSimpleSteps(newContent);
          const completed = allStepsDone(updated);

          if (isBlocked) {
            const nextIdx = findNextStepIdx(updated, id);
            return {
              newState: { ...state, steps: buildWfSteps(updated, nextIdx) },
              result: {
                workflow: 'spec', phase,
                progress: `🚫 ${fileName} 步骤 ${id} 受阻: ${updated[id - 1].text}` +
                  (nextIdx !== -1 ? `\n→ 步骤 ${nextIdx + 1}` : ''),
                allDone: false,
                nextStep: nextIdx !== -1 ? { id: nextIdx + 1, name: updated[nextIdx].text, description: updated[nextIdx].text, status: 'in_progress' } : undefined,
              },
            };
          }

          // Phase transition: tasks → checklist
          if (phase === 'tasks' && completed) {
            const clContent = readFile(specDir, 'checklist.md');
            if (!clContent.trim()) return reject('错误：checklist.md 未找到。');
            const clSteps = parseSimpleSteps(clContent);
            const newPhase = 'checklist' as const;
            const wfSteps = buildWfSteps(clSteps);
            return {
              newState: { ...state, phase: newPhase, data: { ...state.data, phase: newPhase } as unknown as Record<string, unknown>, steps: wfSteps },
              result: {
                workflow: 'spec', phase: 'checklist',
                progress: `✅ Phase 2 完成，进入 Phase 3。${clSteps.length} 个验收项。`,
                allDone: false,
              },
            };
          }

          // Phase 3 all done → complete
          if (phase === 'checklist' && completed) {
            return {
              newState: { ...state, steps: buildWfSteps(updated) },
              result: {
                workflow: 'spec', phase: 'checklist',
                progress: `✅ 全部 ${updated.length} 个验收项已完成。`,
                allDone: true,
              },
            };
          }

          const nextIdx = findNextStepIdx(updated, id);
          return {
            newState: { ...state, steps: buildWfSteps(updated, nextIdx) },
            result: {
              workflow: 'spec', phase,
              progress: `✅ 步骤 ${id} 完成。${nextIdx !== -1 ? `\n下一步: 步骤 ${nextIdx + 1} — ${updated[nextIdx].text}` : ''}`,
              allDone: false,
              nextStep: nextIdx !== -1 ? { id: nextIdx + 1, name: updated[nextIdx].text, description: updated[nextIdx].text, status: 'in_progress' } : undefined,
            },
          };
        }

        default: return null;
      }
    },

    renderForInjection(state) { return this.renderPersistent!(state); },

    renderPersistent(state) {
      const data = getData(state);
      const { task, specDir, phase } = data;
      const specContent = readFile(specDir, 'spec.md');

      if (phase === 'spec') {
        return renderPrompt(loadPrompt('modes/spec-phase1'), { task: task || '(未指定)', specDir });
      }

      const specHeader = specContent.trim()
        ? `## 规格文档 (spec.md)\n\n${specContent}\n`
        : '⚠️ spec.md 为空。\n';

      if (phase === 'tasks') {
        const tasksContent = readFile(specDir, 'tasks.md');
        const sections = parseTaskSections(tasksContent);
        const flat = flattenSections(sections);
        const progressLine = renderProgress(
          flat.filter(f => f.step.done).length, flat.length,
          flat.filter(f => f.step.blocked).length,
        );
        return `## Spec: ${task || ''}\n\n${specHeader}\n${progressLine}`;
      }

      // checklist phase
      const clSteps = parseSimpleSteps(readFile(specDir, 'checklist.md'));
      const progressLine = renderProgress(
        clSteps.filter(s => s.done).length, clSteps.length,
        clSteps.filter(s => s.blocked).length,
      );
      return `## Spec: ${task || ''}\n\n${specHeader}\n${progressLine}`;
    },

    renderStep(state) {
      const data = getData(state);
      const { specDir, phase } = data;
      if (phase === 'spec') return '';

      const wfSteps = state.steps ?? [];
      const cur = wfSteps.find(s => s.status === 'in_progress');
      const total = wfSteps.length;
      const allDone = wfSteps.length > 0 && wfSteps.every(s => s.status === 'completed');
      const allBlocked = wfSteps.length > 0 && wfSteps.every(s => s.status === 'blocked' || s.status === 'completed') &&
        wfSteps.some(s => s.status === 'blocked');

      const label = phase === 'tasks' ? 'Task' : 'Checklist Item';

      if (allDone) return `\n✅ All ${label.toLowerCase()}s complete.`;
      if (!cur) {
        const next = wfSteps.find(s => s.status === 'pending');
        if (next) return `\n### Next ${label}\n🔄 **${next.id}. ${next.description}**\n\nVerify: \`workflow({action:"step", id:${next.id}, stepAction:"done"})\``;
        if (allBlocked) return '\n⚠️ All remaining items are blocked.';
        return '';
      }

      return `\n### Current ${label} (${cur.id}/${total})\n🔄 **${cur.description}**\n\nMark done:\n\`\`\`\nworkflow({action:"step", id:${cur.id}, stepAction:"done"})\n\`\`\``;
    },

    isComplete(state) {
      const data = getData(state);
      if (data.phase !== 'checklist') return false;
      const content = readFile(data.specDir, 'checklist.md');
      if (!content.trim()) return false;
      return allStepsDone(parseSimpleSteps(content));
    },
  };
}
