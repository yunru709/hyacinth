/**
 * TODO Workflow — 框架驱动的轻量任务跟踪（纯内存）。
 *
 * 与 Plan 同模式但步骤不写文件，适合轻量快速任务。
 *
 * ## 模式
 *
 *   analyze phase → 引导模型用 note 记录分析、用 add 添加步骤
 *                  完成后调 complete → 切 execute
 *   execute phase → 分析结果(持久) + 仅当前步骤，逐条驱动
 *   all done      → 框架自动停用
 *
 * ## 与 Plan 的关键差异
 *
 *   - 步骤存内存（data.steps），不写文件
 *   - 分析通过 note action 累积到 data.analysis（Plan 用 plan.md）
 *   - 不依赖文件操作，无需 import shared/file-steps
 *
 * ## 原始 todo.mode.ts 设计
 *
 *   - 框架驱动：激活→引导分析→逐条注入步骤→自动结束
 *   - 分析结果作为持久上下文，执行阶段持续注入
 *   - 执行阶段模型只看到当前步骤，不被全量步骤列表干扰
 */

import type { WorkflowDefinition, WorkflowState } from '../types.js';
import { loadPrompt, renderPrompt } from '../../prompts/loader.js';

// ─── 内部类型 ───────────────────────────────────────────────────────

interface TodoStep {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  reason?: string;
}

interface TodoData {
  task: string;
  analysis: string;
  steps: TodoStep[];
  phase: 'analyze' | 'execute';
}

function getData(state: WorkflowState): TodoData {
  return state.data as unknown as TodoData;
}

function setData(state: WorkflowState, data: TodoData): WorkflowState {
  return { ...state, data: data as unknown as Record<string, unknown> };
}

function allStepsDone(steps: TodoStep[]): boolean {
  return steps.length > 0 && steps.every(s => s.status === 'completed');
}

function currentStep(steps: TodoStep[]): TodoStep | undefined {
  return steps.find(s => s.status === 'in_progress');
}

function pendingSteps(steps: TodoStep[]): TodoStep[] {
  return steps.filter(s => s.status === 'pending');
}

// ─── 工厂 ───────────────────────────────────────────────────────────

export function createTodoWorkflow(): WorkflowDefinition {
  return {
    name: 'todo',
    description: '任务跟踪模式 — LLM 自主分解步骤并逐步完成',
    source: 'builtin',
    relatedTools: ['read', 'write', 'edit', 'glob', 'grep', 'bash'],
    triggerKeywords: ['todo', 'task', 'break down', 'step by step'],

    createState(params) {
      return {
        name: 'todo',
        data: {
          task: String(params.task ?? ''),
          analysis: '',
          steps: [],
          phase: 'analyze',
        } as unknown as Record<string, unknown>,
        steps: [],
        startedAt: new Date().toISOString(),
      };
    },

    handleStep(state, action) {
      const data = getData(state);
      const { phase } = data;

      switch (action.action) {

        // ── analyze phase ──────────────────────────────────────────

        case 'add': {
          const newId = data.steps.length > 0
            ? Math.max(...data.steps.map(s => s.id)) + 1
            : 1;
          const desc = String(action.description ?? 'New step');
          const initialStatus: TodoStep['status'] =
            phase === 'execute' ? 'pending'
            : data.steps.length === 0 ? 'in_progress' : 'pending';

          data.steps.push({ id: newId, description: desc, status: initialStatus });

          if (phase === 'execute') {
            // 执行阶段动态添加：如果之前全 done/blocked，激活第一个 pending
            const cur = currentStep(data.steps);
            if (!cur) {
              const first = pendingSteps(data.steps)[0];
              if (first) first.status = 'in_progress';
            }
          }

          return {
            newState: syncSteps(state, data),
            result: {
              workflow: 'todo',
              progress: phase === 'analyze'
                ? `✅ 步骤 ${newId} 已添加: ${desc}（共 ${data.steps.length} 步）`
                : `✅ 已添加新步骤 ${newId}: ${desc}`,
              allDone: false,
            },
          };
        }

        case 'note': {
          // 分析文本累积到 analysis 字段，作为持久上下文
          const msg = action.message ?? '';
          if (msg) {
            data.analysis = data.analysis
              ? `${data.analysis}\n${msg}`
              : msg;
          }
          return {
            newState: syncSteps(state, data),
            result: {
              workflow: 'todo',
              progress: '分析已记录。',
              allDone: false,
            },
          };
        }

        case 'progress': {
          // progress 等同于 note，追加到分析
          const msg = action.message ?? 'Progress noted.';
          data.analysis = data.analysis
            ? `${data.analysis}\n${msg}`
            : msg;
          return {
            newState: syncSteps(state, data),
            result: {
              workflow: 'todo',
              progress: msg,
              allDone: false,
            },
          };
        }

        case 'complete': {
          if (phase === 'analyze') {
            // 分析完成 → 切换到执行阶段
            if (data.steps.length === 0) {
              return {
                newState: state,
                result: {
                  workflow: 'todo',
                  progress: '错误：没有步骤。请先用 workflow add 添加至少一个步骤。',
                  allDone: false,
                },
              };
            }

            data.phase = 'execute';
            // 第一个步骤设为 in_progress
            const first = data.steps[0];
            if (first && first.status === 'pending') {
              first.status = 'in_progress';
            }

            const cur = currentStep(data.steps);
            return {
              newState: syncSteps(state, data),
              result: {
                workflow: 'todo',
                progress: `✅ 分析完成，进入执行阶段。共 ${data.steps.length} 个步骤。\n开始执行第 1 步: ${cur?.description ?? ''}`,
                allDone: false,
                nextStep: cur ? { id: cur.id, name: cur.description, description: cur.description, status: 'in_progress' } : undefined,
              },
            };
          }

          // 执行阶段的 complete：全局完成标记
          return {
            newState: state,
            result: {
              workflow: 'todo',
              progress: '✅ TODO workflow marked complete.',
              allDone: false,
            },
          };
        }

        // ── execute phase ──────────────────────────────────────────

        case 'done': {
          if (phase === 'analyze') {
            return {
              newState: state,
              result: {
                workflow: 'todo',
                progress: '当前处于分析阶段，请先用 workflow({action:"step", stepAction:"complete"}) 完成分析，进入执行阶段后再标记步骤。',
                allDone: false,
              },
            };
          }

          const id = (action.id ?? 0) as number;
          const step = data.steps.find(s => s.id === id);
          if (!step) {
            return {
              newState: state,
              result: {
                workflow: 'todo',
                progress: `错误：步骤 ${id} 不存在。当前共 ${data.steps.length} 个步骤（编号 ${data.steps.map(s => s.id).join(', ')}）。`,
                allDone: false,
              },
            };
          }

          step.status = 'completed';

          // 自动推进到下一个 pending 步骤
          const next = pendingSteps(data.steps)[0];
          if (next) next.status = 'in_progress';

          const done = allStepsDone(data.steps);

          return {
            newState: syncSteps(state, data),
            result: {
              workflow: 'todo',
              progress: done
                ? `✅ 步骤 ${id} 完成。全部 ${data.steps.length} 个步骤已完成。`
                : next
                  ? `✅ 步骤 ${id} 完成。\n下一步: 步骤 ${next.id} — ${next.description}`
                  : `✅ 步骤 ${id} 完成。`,
              allDone: done,
              nextStep: next ? { id: next.id, name: next.description, description: next.description, status: 'in_progress' } : undefined,
            },
          };
        }

        case 'blocked': {
          if (phase === 'analyze') {
            return {
              newState: state,
              result: {
                workflow: 'todo',
                progress: '当前处于分析阶段，请先用 workflow({action:"step", stepAction:"complete"}) 完成分析。',
                allDone: false,
              },
            };
          }

          const id = (action.id ?? 0) as number;
          const step = data.steps.find(s => s.id === id);
          if (step) {
            step.status = 'blocked';
            step.reason = action.message ?? '';
          }
          // 自动激活下一个未受阻步骤
          const next = pendingSteps(data.steps)[0];
          if (next) next.status = 'in_progress';

          return {
            newState: syncSteps(state, data),
            result: {
              workflow: 'todo',
              progress: step
                ? `🚫 步骤 ${id} 标记为受阻: ${step.description}${step.reason ? ` — ${step.reason}` : ''}`
                : `错误：步骤 ${id} 不存在。`,
              allDone: false,
              nextStep: next ? { id: next.id, name: next.description, description: next.description, status: 'in_progress' } : undefined,
            },
          };
        }

        default:
          return null;
      }
    },

    renderForInjection(state) {
      // 兼容回退：未实现 renderPersistent/renderStep 时使用
      return this.renderPersistent!(state);
    },

    renderPersistent(state) {
      const { task, analysis, steps, phase } = getData(state);

      if (phase === 'analyze') {
        // 分析阶段：引导提示词一次注入（持久直到 complete）
        const template = loadPrompt('modes/todo');
        return renderPrompt(template, { task: task || '(未指定)' });
      }

      // ── execute phase: 分析结果持久 ──
      const completed = steps.filter(s => s.status === 'completed').length;
      const blocked = steps.filter(s => s.status === 'blocked').length;
      const total = steps.length;

      const analysisBlock = analysis ? `### Analysis\n${analysis}\n` : '';
      const progressLine = `**Progress**: ${completed} done${blocked > 0 ? `, ${blocked} blocked` : ''}, ${total - completed - blocked} remaining`;

      return `## TODO: ${task}\n\n${analysisBlock}${progressLine}`;
    },

    renderStep(state) {
      const { steps, phase } = getData(state);

      if (phase !== 'execute') return '';

      const cur = currentStep(steps);

      if (!cur) {
        if (allStepsDone(steps)) {
          return '\n✅ All steps complete. The workflow will end.';
        }
        const next = pendingSteps(steps)[0];
        if (next) {
          return `\n### Next Step\n🔄 **${next.id}. ${next.description}**\n\nExecute this step. When done: \`workflow({action:"step", id:${next.id}, stepAction:"done"})\`\nIf blocked: \`workflow({action:"step", id:${next.id}, stepAction:"blocked", message:"reason"})\``;
        }
        if (steps.filter(s => s.status === 'blocked').length > 0) {
          return '\n⚠️ All remaining steps are blocked. Resolve blockers to continue.';
        }
        return '';
      }

      return `
### Current Step (${cur.id}/${steps.length})
🔄 **${cur.description}**

Execute this step now. When done:
\`\`\`
workflow({action:"step", id:${cur.id}, stepAction:"done"})
\`\`\`
If blocked:
\`\`\`
workflow({action:"step", id:${cur.id}, stepAction:"blocked", message:"reason"})
\`\`\`
To add a new step during execution:
\`\`\`
workflow({action:"step", stepAction:"add", description:"new step"})
\`\`\``;
    },

    isComplete(state) {
      const { steps, phase } = getData(state);
      return phase === 'execute' && allStepsDone(steps);
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function syncSteps(state: WorkflowState, data: TodoData): WorkflowState {
  const wfSteps = data.steps.map(s => ({
    id: s.id,
    name: s.description,
    description: s.description,
    status: s.status,
    reason: s.reason,
  }));
  return setData({ ...state, steps: wfSteps }, data);
}
