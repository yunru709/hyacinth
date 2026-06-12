/**
 * TODO Mode（工具驱动版）。
 *
 * 流程: task_start → 激活 TODO → LLM 分析并输出步骤 → task_mark 标记 → 全部 done → 自动停用
 * 与 Plan 模式的区别：TODO 由 LLM 通过 task_start 工具自主激活，无需用户手动 /plan。
 */

import type { ModeDefinition, ModeState, TaskMarkResult } from './types.js';
import { loadPrompt, renderPrompt } from '../prompts/loader.js';

// ─── 内部类型 ───────────────────────────────────────────────────────

interface TodoStep {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

interface TodoData {
  task: string;
  steps: TodoStep[];
}

// ─── 辅助 ───────────────────────────────────────────────────────────

function getData(state: ModeState): TodoData {
  return state.data as unknown as TodoData;
}

function setData(state: ModeState, data: TodoData): ModeState {
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
      case 'blocked':     return `  🚫 ${s.description} — ${(s as any).reason ?? '受阻'}`;
      default:            return `  ⬜ ${s.description}`;
    }
  }).join('\n');
}

// ─── 工厂 ───────────────────────────────────────────────────────────

export function createTodoMode(): ModeDefinition {
  return {
    name: 'todo',

    createState(params) {
      return {
        name: 'todo',
        data: {
          task: String(params.task ?? ''),
          steps: [],
        } as unknown as Record<string, unknown>,
      };
    },

    handleToolCall(state, action, params) {
      const data = getData(state);

      switch (action) {
        case 'done': {
          const id = (params.id ?? 0) as number;
          while (data.steps.length < id) {
            data.steps.push({ id: data.steps.length + 1, description: `Step ${data.steps.length + 1}`, status: 'pending' });
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
          const s = data.steps.find(s => s.id === (params.id ?? 0));
          if (s) { s.status = 'blocked'; (s as any).reason = params.message ?? ''; }
          break;
        }

        case 'add': {
          data.steps.push({ id: data.steps.length + 1, description: String(params.description ?? 'New step'), status: 'pending' });
          break;
        }

        case 'note':
          break;

        default:
          return null;
      }

      const result: TaskMarkResult = {
        mode: 'todo',
        progress: renderProgress(data.steps),
        allDone: allDone(data.steps),
      };
      return { newState: setData(state, data), result };
    },

    renderForInjection(state) {
      const data = getData(state);
      const template = loadPrompt('modes/todo');
      return renderPrompt(template, { progress: renderProgress(data.steps) });
    },

    isComplete(state) {
      return allDone(getData(state).steps);
    },
  };
}
