/**
 * TODO Workflow — 内存步骤数组
 *
 * 与 todo.mode.ts 逻辑一致，套 WorkflowDefinition 接口。
 * LLM 通过 workflow({action:"activate", name:"todo"}) 激活，
 * 通过 workflow({action:"step", ...}) 标记步骤。
 */

import type { WorkflowDefinition, WorkflowState, WorkflowStepAction, WorkflowStepResult } from '../types.js';

// ─── 内部类型 ───────────────────────────────────────────────────────

interface TodoStep {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  reason?: string;
}

interface TodoData {
  task: string;
  steps: TodoStep[];
}

function getData(state: WorkflowState): TodoData {
  return state.data as unknown as TodoData;
}

function setData(state: WorkflowState, data: TodoData): WorkflowState {
  return { ...state, data: data as unknown as Record<string, unknown> };
}

function allDone(steps: TodoStep[]): boolean {
  return steps.length > 0 && steps.every(s => s.status === 'completed');
}

function renderProgress(steps: TodoStep[]): string {
  if (steps.length === 0) return '(暂无步骤 — 请分析任务并输出步骤列表)';
  return steps.map(s => {
    switch (s.status) {
      case 'completed':   return `  ✅  ${s.description}`;
      case 'in_progress': return `  🔄 ${s.description} ← 当前`;
      case 'blocked':     return `  🚫 ${s.description} — ${s.reason ?? '受阻'}`;
      default:            return `  ⬜ ${s.description}`;
    }
  }).join('\n');
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
          steps: [],
        } as unknown as Record<string, unknown>,
        steps: [],
        startedAt: new Date().toISOString(),
      };
    },

    handleStep(state, action) {
      const data = getData(state);

      switch (action.action) {
        case 'done': {
          const id = (action.id ?? 0) as number;
          while (data.steps.length < id) {
            data.steps.push({
              id: data.steps.length + 1,
              description: `Step ${data.steps.length + 1}`,
              status: 'pending',
            });
          }
          const s = data.steps.find(s => s.id === id);
          if (s) {
            s.status = 'completed';
            const n = data.steps.find(s => s.id === id + 1);
            if (n && n.status === 'pending') n.status = 'in_progress';
          }
          break;
        }

        case 'blocked': {
          const s = data.steps.find(s => s.id === (action.id ?? 0));
          if (s) { s.status = 'blocked'; s.reason = action.message ?? ''; }
          break;
        }

        case 'add': {
          data.steps.push({
            id: data.steps.length + 1,
            description: String(action.description ?? 'New step'),
            status: 'pending',
          });
          break;
        }

        case 'note':
          break;

        default:
          return null;
      }

      // sync WorkflowState.steps for external visibility
      const wfSteps = data.steps.map(s => ({
        id: s.id,
        name: s.description,
        description: s.description,
        status: s.status,
        reason: s.reason,
      }));

      const result: WorkflowStepResult = {
        workflow: 'todo',
        progress: renderProgress(data.steps),
        allDone: allDone(data.steps),
      };

      return {
        newState: { ...setData(state, data), steps: wfSteps },
        result,
      };
    },

    renderForInjection(state) {
      const data = getData(state);
      const progress = renderProgress(data.steps);

      return `## TODO Workflow: ${data.task || '(任务未指定)'}

**进度**:
${progress}

使用 \`workflow({action:"step", id:N, stepAction:"done"})\` 标记步骤完成。
使用 \`workflow({action:"step", stepAction:"add", description:"新步骤"})\` 添加步骤。
使用 \`workflow({action:"step", id:N, stepAction:"blocked", message:"原因"})\` 标记受阻。`;
    },

    isComplete(state) {
      return allDone(getData(state).steps);
    },
  };
}
