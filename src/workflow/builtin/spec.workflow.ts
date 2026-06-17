/**
 * Spec Workflow — 三阶段，文件驱动。
 *
 * 文件: ~/.agent/specs/<slug>/spec.md | tasks.md | checklist.md
 * 复用 spec.mode.ts 和 mode-tools.ts 的三阶段逻辑。
 *
 * Phase 1 (spec): 收集需求，编写 spec.md → id:0 推进到 Phase 2
 * Phase 2 (tasks): 执行步骤，标记 checkbox → 全部完成推进到 Phase 3
 * Phase 3 (checklist): 逐项验收 → 全部完成结束
 */

import type { WorkflowDefinition, WorkflowState } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── 内部类型 ───────────────────────────────────────────────────────

interface SpecData {
  task: string;
  phase: 'spec' | 'tasks' | 'checklist';
  specDir: string;
}

function getData(state: WorkflowState): SpecData {
  return state.data as unknown as SpecData;
}

function setPhase(state: WorkflowState, phase: SpecData['phase']): WorkflowState {
  const data = getData(state);
  return { ...state, phase, data: { ...state.data, phase } as unknown as Record<string, unknown> };
}

// ─── 文件操作 ───────────────────────────────────────────────────────

function readFile(specDir: string, name: string): string {
  try { return fs.readFileSync(path.join(specDir, name), 'utf-8'); } catch { return ''; }
}

function writeFile(specDir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(specDir, name), content, 'utf-8');
}

/** 解析 "- [ ] 描述" 行 */
function parseSteps(content: string): Array<{ lineIdx: number; text: string; done: boolean }> {
  const steps: Array<{ lineIdx: number; text: string; done: boolean }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[(.)\] (.+)/);
    if (m) steps.push({ lineIdx: i, text: m[2].trim(), done: m[1] !== ' ' });
  }
  return steps;
}

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

/** 获取当前 phase 对应的文件名 */
function getPhaseFile(phase: string): string {
  switch (phase) {
    case 'spec': return 'spec.md';
    case 'tasks': return 'tasks.md';
    case 'checklist': return 'checklist.md';
    default: return 'spec.md';
  }
}

/** 创建初始模板文件 */
function createTemplateFiles(specDir: string, task: string): void {
  if (!fs.existsSync(path.join(specDir, 'spec.md'))) {
    fs.writeFileSync(path.join(specDir, 'spec.md'),
      `# Spec: ${task}\n\n## 需求分析\n\n## 技术方案\n`, 'utf-8');
  }
  if (!fs.existsSync(path.join(specDir, 'tasks.md'))) {
    fs.writeFileSync(path.join(specDir, 'tasks.md'),
      `- [ ] 步骤1\n- [ ] 步骤2\n`, 'utf-8');
  }
  if (!fs.existsSync(path.join(specDir, 'checklist.md'))) {
    fs.writeFileSync(path.join(specDir, 'checklist.md'),
      `- [ ] 核心功能正常\n- [ ] 异常输入处理\n`, 'utf-8');
  }
}

// ─── 工厂 ───────────────────────────────────────────────────────────

export function createSpecWorkflow(): WorkflowDefinition {
  return {
    name: 'spec',
    description: '规格化开发模式 — 三阶段：需求→执行→验收',
    source: 'builtin',
    relatedTools: ['read', 'write', 'edit', 'glob', 'grep'],
    triggerKeywords: ['spec', 'specification', 'requirement', 'design'],

    createState(params) {
      const task = String(params.task ?? '');
      const taskSlug = task.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-').slice(0, 60) || 'spec';
      const specDir = path.join(os.homedir(), '.agent', 'specs', taskSlug);
      if (!fs.existsSync(specDir)) fs.mkdirSync(specDir, { recursive: true });

      createTemplateFiles(specDir, task);

      return {
        name: 'spec',
        phase: 'spec',
        data: { task, phase: 'spec', specDir } as unknown as Record<string, unknown>,
        steps: [],
        startedAt: new Date().toISOString(),
      };
    },

    handleStep(state, action) {
      const { specDir } = getData(state);
      const phase = state.phase ?? 'spec';

      // ── Spec Phase 1 → Phase 2 (id:0 done) ────────────────────
      if (phase === 'spec' && action.action === 'done' && action.id === 0) {
        const tasksContent = readFile(specDir, 'tasks.md');
        if (!tasksContent.trim()) {
          return {
            newState: state,
            result: {
              workflow: 'spec',
              phase: 'spec',
              progress: '错误：tasks.md 未找到或为空。请先用 write 创建 tasks.md。',
              allDone: false,
            },
          };
        }

        const steps = parseSteps(tasksContent);
        if (steps.length === 0) {
          return {
            newState: state,
            result: {
              workflow: 'spec',
              phase: 'spec',
              progress: '错误：tasks.md 中没有检测到步骤（格式: - [ ] 描述）。',
              allDone: false,
            },
          };
        }

        const newState = setPhase(state, 'tasks');
        const wfSteps = steps.map((s, i) => ({
          id: i + 1,
          name: s.text,
          description: s.text,
          status: s.done ? 'completed' as const
            : (i === 0 ? 'in_progress' as const : 'pending' as const),
        }));

        return {
          newState: { ...newState, steps: wfSteps },
          result: {
            workflow: 'spec',
            phase: 'tasks',
            progress: `✅ Phase 1 完成，进入 Phase 2 执行阶段。\n解析到 ${steps.length} 个步骤:\n` +
              steps.map((s, i) => `  ${i + 1}. ${s.done ? '✅' : '⬜'} ${s.text}`).join('\n') +
              `\n开始执行第 1 步。每步完成后调用 workflow({action:"step", id:N, stepAction:"done"})。`,
            allDone: false,
            nextStep: wfSteps[0],
          },
        };
      }

      // ── Spec Phase 1 guard: reject operations other than id:0 ──
      if (phase === 'spec' && action.action !== 'note' && action.action !== 'progress') {
        return {
          newState: state,
          result: {
            workflow: 'spec',
            phase: 'spec',
            progress: 'Phase 1 (spec) 不接受步骤操作。请先完成 spec.md 的需求分析和技术方案设计，确认无误后调用 workflow({action:"step", id:0, stepAction:"done"}) 进入 Phase 2。',
            allDone: false,
          },
        };
      }

      // ── Phase 2 or 3: add step ─────────────────────────────────
      if (action.action === 'add') {
        const fileName = getPhaseFile(phase);
        let content = readFile(specDir, fileName);
        const desc = action.description ?? 'New step';
        content += `\n- [ ] ${desc}`;
        writeFile(specDir, fileName, content);

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
            workflow: 'spec',
            phase,
            progress: `✅ 已添加步骤到 ${fileName}: ${desc}`,
            allDone: false,
          },
        };
      }

      // ── Phase 2 or 3: done / blocked ───────────────────────────
      if (action.action === 'done' || action.action === 'blocked') {
        const id = action.id ?? 0;
        if (id < 1) return null;

        const fileName = getPhaseFile(phase);
        let content: string;
        try { content = fs.readFileSync(path.join(specDir, fileName), 'utf-8'); } catch {
          return null;
        }

        const steps = parseSteps(content);
        if (id > steps.length) {
          return {
            newState: state,
            result: {
              workflow: 'spec',
              phase,
              progress: `错误：步骤 ${id} 不存在。${fileName} 中共 ${steps.length} 个步骤（编号 1-${steps.length}）。`,
              allDone: false,
            },
          };
        }

        const mark = action.action === 'done' ? 'x' : '🚫';
        const newContent = markStepInFile(content, id - 1, mark, action.message);
        writeFile(specDir, fileName, newContent);

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
              workflow: 'spec',
              phase,
              progress: `🚫 ${fileName} 步骤 ${id} 已标记为受阻: ${currentStep.text}`,
              allDone: false,
            },
          };
        }

        // done: check for phase transition
        const allCompleted = updatedSteps.every(s => s.done);

        // Phase 2 (tasks) all done → Phase 3 (checklist)
        if (phase === 'tasks' && allCompleted) {
          const clContent = readFile(specDir, 'checklist.md');
          if (!clContent.trim()) {
            return {
              newState: state,
              result: {
                workflow: 'spec',
                phase: 'tasks',
                progress: '错误：checklist.md 未找到。',
                allDone: false,
              },
            };
          }
          const clSteps = parseSteps(clContent);
          const newState = setPhase(state, 'checklist');
          const wfSteps = clSteps.map((s, i) => ({
            id: i + 1,
            name: s.text,
            description: s.text,
            status: s.done ? 'completed' as const
              : (i === 0 ? 'in_progress' as const : 'pending' as const),
          }));

          return {
            newState: { ...newState, steps: wfSteps },
            result: {
              workflow: 'spec',
              phase: 'checklist',
              progress: `✅ Phase 2 全部完成，进入 Phase 3 验收阶段。\n解析到 ${clSteps.length} 个验收项:\n` +
                clSteps.map((s, i) => `  ${i + 1}. ${s.done ? '✅' : '⬜'} ${s.text}`).join('\n') +
                `\n逐项验证，每项完成后调用 workflow({action:"step", id:N, stepAction:"done"})。`,
              allDone: false,
            },
          };
        }

        // Phase 3 (checklist) all done → complete
        if (phase === 'checklist' && allCompleted) {
          return {
            newState: {
              ...state,
              steps: updatedSteps.map((s, i) => ({
                id: i + 1,
                name: s.text,
                description: s.text,
                status: 'completed' as const,
              })),
            },
            result: {
              workflow: 'spec',
              phase: 'checklist',
              progress: `✅ 全部 ${updatedSteps.length} 个验收项已完成。工作流已结束。`,
              allDone: true,
            },
          };
        }

        // regular step done
        const nextIdx = updatedSteps.findIndex((s, i) => i >= id && !s.done);

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
            workflow: 'spec',
            phase,
            progress: nextIdx === -1
              ? `✅ 步骤 ${id} 完成。`
              : `✅ 步骤 ${id} 完成。\n下一步: 步骤 ${nextIdx + 1} — ${updatedSteps[nextIdx].text}`,
            allDone: false,
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
      const { task, specDir } = getData(state);
      const phase = state.phase ?? 'spec';
      const specContent = readFile(specDir, 'spec.md');

      const specAnchor = specContent
        ? `\n---\n## 规格文档 (spec.md)\n${specContent}\n---\n`
        : '\n(还未创建 spec.md — 请用 write 编辑)\n';

      switch (phase) {
        case 'spec': {
          return `## Spec Workflow — Phase 1: 需求分析

**任务**: ${task || '(未指定)'}
**目录**: ${specDir}

当前阶段：收集需求、分析技术方案。用 write 编辑 spec.md。
完成后调用 \`workflow({action:"step", id:0, stepAction:"done"})\` 进入执行阶段。
${specAnchor}`;
        }

        case 'tasks': {
          const tasksContent = readFile(specDir, 'tasks.md');
          const steps = parseSteps(tasksContent);
          const next = steps.find(s => !s.done);
          const progress = steps.map((s, i) => {
            const mark = s.done ? '✅' : (s === next ? '🔄' : '⬜');
            return `  ${mark} [${i + 1}] ${s.text}`;
          }).join('\n');

          return `${specAnchor}
## Spec Workflow — Phase 2: 执行阶段

**进度**:
${progress || '(暂无步骤)'}

${next ? `🔄 当前: 步骤 ${steps.findIndex(s => !s.done) + 1} — ${next.text}` : (tasksContent ? '✅ 全部完成 — 下一步自动进入 Phase 3' : '')}

使用 \`workflow({action:"step", id:N, stepAction:"done"})\` 标记步骤完成。`;
        }

        case 'checklist': {
          const clContent = readFile(specDir, 'checklist.md');
          const steps = parseSteps(clContent);
          const next = steps.find(s => !s.done);
          const progress = steps.map((s, i) => {
            const mark = s.done ? '✅' : (s === next ? '🔄' : '⬜');
            return `  ${mark} [${i + 1}] ${s.text}`;
          }).join('\n');

          return `${specAnchor}
## Spec Workflow — Phase 3: 验收阶段

**验收项**:
${progress || '(暂无验收项)'}

${next ? `🔄 当前: 检查项 ${steps.findIndex(s => !s.done) + 1} — ${next.text}` : (clContent ? '✅ 全部验收完成' : '')}

使用 \`workflow({action:"step", id:N, stepAction:"done"})\` 标记验收项通过。`;
        }

        default: return '';
      }
    },

    isComplete(state) {
      const { specDir } = getData(state);
      if (state.phase !== 'checklist') return false;
      const content = readFile(specDir, 'checklist.md');
      if (!content.trim()) return false;
      const steps = parseSteps(content);
      return steps.length > 0 && steps.every(s => s.done);
    },
  };
}
