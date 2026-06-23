/**
 * JSON Workflow Loader
 *
 * 将 JSON 格式的工作流定义编译为 WorkflowDefinition 运行时对象。
 *
 * JSON 格式：
 * {
 *   "name": "todo",
 *   "description": "描述",
 *   "triggerKeywords": ["todo", "task"],
 *   "relatedTools": ["read", "write"],
 *   "phases": [
 *     {
 *       "name": "analyze",
 *       "prompt": "注入到 Zone 5 persistent 的内容",
 *       "allowedActions": ["add", "complete"],
 *       "onComplete": { "transitionTo": "execute" }
 *     },
 *     {
 *       "name": "execute",
 *       "prompt": "执行阶段引导",
 *       "allowedActions": ["done", "blocked", "add", "complete"],
 *       "onComplete": null,
 *       "stepPrompt": "请执行步骤 {stepName}: {stepDescription}"
 *     }
 *   ],
 *   "complete": {
 *     "condition": "all_done",
 *     "phase": "execute"
 *   }
 * }
 */

import type {
  WorkflowDefinition,
  WorkflowState,
  WorkflowStep,
  WorkflowStepAction,
  WorkflowStepResult,
} from './types.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { compileGraphWorkflow } from './graph-engine.js';
import type { WorkflowGraph } from './graph-types.js';
// 导入 node-executors 模块以触发默认执行器注册（副作用导入）
import './node-executors/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── JSON Schema 类型 ───────────────────────────────────────────────

export interface WorkflowPhaseDef {
  name: string;
  prompt: string;
  allowedActions: string[];
  onComplete?: { transitionTo: string | null } | null;
  stepPrompt?: string;
}

export interface WorkflowCompleteDef {
  condition: 'all_done' | 'phase_complete';
  phase?: string;
}

export interface WorkflowJson {
  name: string;
  description: string;
  triggerKeywords?: string[];
  relatedTools?: string[];
  phases: WorkflowPhaseDef[];
  complete: WorkflowCompleteDef;
}

// ─── 辅助函数 ───────────────────────────────────────────────────────

function findNextStep(steps: WorkflowStep[]): WorkflowStep | undefined {
  return steps.find(s => s.status === 'pending' || s.status === 'in_progress');
}

function allDone(steps: WorkflowStep[]): boolean {
  return steps.length > 0 && steps.every(s => s.status === 'completed');
}

function renderProgress(steps: WorkflowStep[], task?: string): string {
  const total = steps.length;
  const done = steps.filter(s => s.status === 'completed').length;
  const blocked = steps.filter(s => s.status === 'blocked').length;
  const pending = steps.filter(s => s.status === 'pending').length;

  const lines: string[] = [];
  if (task) lines.push(`**Task:** ${task}`);
  lines.push(`**Progress:** ${done}/${total} done, ${pending} pending, ${blocked} blocked`);
  lines.push('');
  for (const step of steps) {
    const mark =
      step.status === 'completed' ? '[x]' :
      step.status === 'blocked' ? '[!]' :
      step.status === 'in_progress' ? '[~]' : '[ ]';
    lines.push(`${mark} ${step.name}`);
  }
  return lines.join('\n');
}

function renderStepPrompt(template: string, step: WorkflowStep): string {
  return template
    .replace('{stepId}', String(step.id))
    .replace('{stepName}', step.name)
    .replace('{stepDescription}', step.description);
}

// ─── 核心编译函数 ───────────────────────────────────────────────────

/**
 * 将 JSON 工作流定义编译为 WorkflowDefinition 运行时对象。
 */
export function compileWorkflow(json: WorkflowJson, source: 'builtin' | 'file' = 'file'): WorkflowDefinition {
  const phaseMap = new Map(json.phases.map(p => [p.name, p]));
  const firstPhase = json.phases[0];

  if (!firstPhase) {
    throw new Error(`Workflow "${json.name}" has no phases`);
  }

  return {
    name: json.name,
    description: json.description,
    source,
    triggerKeywords: json.triggerKeywords,
    relatedTools: json.relatedTools,

    createState(params: Record<string, unknown>): WorkflowState {
      const task = (params.task as string) ?? '';
      return {
        name: json.name,
        phase: firstPhase.name,
        data: { task, analysis: '' },
        steps: [],
        startedAt: new Date().toISOString(),
      };
    },

    handleStep(state: WorkflowState, action: WorkflowStepAction): { newState: WorkflowState; result: WorkflowStepResult } | null {
      const currentPhase = phaseMap.get(state.phase ?? '');
      if (!currentPhase) return null;

      // 检查 action 是否被允许
      if (!currentPhase.allowedActions.includes(action.action)) {
        return null;
      }

      let newState = { ...state, data: { ...state.data }, steps: state.steps.map(s => ({ ...s })) };

      switch (action.action) {
        case 'add': {
          const newId = newState.steps.length > 0
            ? Math.max(...newState.steps.map(s => s.id)) + 1
            : 1;
          const desc = action.description ?? `Step ${newId}`;
          newState.steps.push({
            id: newId,
            name: desc,
            description: desc,
            status: 'pending',
          });
          break;
        }

        case 'done': {
          if (action.id == null) return null;
          const step = newState.steps.find(s => s.id === action.id);
          if (!step) return null;
          step.status = 'completed';
          break;
        }

        case 'blocked': {
          if (action.id == null) return null;
          const step = newState.steps.find(s => s.id === action.id);
          if (!step) return null;
          step.status = 'blocked';
          step.reason = action.message;
          break;
        }

        case 'note':
        case 'progress': {
          // 透传消息，不改变步骤状态
          if (action.message) {
            const existing = (newState.data.analysis as string) ?? '';
            newState.data.analysis = existing
              ? `${existing}\n${action.message}`
              : action.message;
          }
          break;
        }

        case 'complete': {
          const onComplete = currentPhase.onComplete;
          if (onComplete?.transitionTo) {
            newState.phase = onComplete.transitionTo;
          }
          break;
        }
      }

      // 构建结果
      const nextStep = findNextStep(newState.steps);
      const task = newState.data.task as string;
      const progress = renderProgress(newState.steps, task);

      // 检查完成
      let allDoneFlag = false;
      if (json.complete.condition === 'all_done') {
        const checkPhase = json.complete.phase;
        if (!checkPhase || newState.phase === checkPhase) {
          allDoneFlag = allDone(newState.steps);
        }
      } else if (json.complete.condition === 'phase_complete') {
        allDoneFlag = action.action === 'complete' &&
          json.complete.phase === newState.phase;
      }

      return {
        newState,
        result: {
          workflow: json.name,
          phase: newState.phase,
          progress,
          allDone: allDoneFlag,
          nextStep,
        },
      };
    },

    renderPersistent(state: WorkflowState): string {
      const phase = phaseMap.get(state.phase ?? '');
      if (!phase) return '';

      let content = phase.prompt;

      // 执行阶段追加进度摘要
      if (state.phase !== firstPhase.name && state.steps.length > 0) {
        const task = state.data.task as string;
        content += '\n\n' + renderProgress(state.steps, task);
      }

      // 追加分析内容
      const analysis = state.data.analysis as string;
      if (analysis) {
        content += `\n\n### Notes\n${analysis}`;
      }

      return content;
    },

    renderStep(state: WorkflowState): string {
      const phase = phaseMap.get(state.phase ?? '');
      if (!phase || !phase.stepPrompt) return '';

      const step = findNextStep(state.steps);
      if (!step) return '';

      return renderStepPrompt(phase.stepPrompt, step);
    },

    renderForInjection(state: WorkflowState): string {
      return this.renderPersistent?.(state) ?? '';
    },

    isComplete(state: WorkflowState): boolean {
      if (json.complete.condition === 'all_done') {
        const checkPhase = json.complete.phase;
        if (checkPhase && state.phase !== checkPhase) return false;
        return allDone(state.steps);
      }
      if (json.complete.condition === 'phase_complete') {
        return state.phase === json.complete.phase;
      }
      return false;
    },
  };
}

// ─── 文件加载 ───────────────────────────────────────────────────────

/**
 * 从 JSON 文件加载工作流。
 *
 * 自动检测 JSON 格式：
 *   - 含 "nodes" 数组 → graph-based 工作流，调用 compileGraphWorkflow()
 *   - 含 "phases" 数组 → phase-based 工作流，调用 compileWorkflow()
 *   - 两者都有或都没有 → 抛出错误
 */
export function loadWorkflowFile(filePath: string, source: 'builtin' | 'file' = 'file'): WorkflowDefinition {
  const content = readFileSync(filePath, 'utf-8');
  const json = JSON.parse(content) as Record<string, unknown>;

  const hasNodes = Array.isArray(json.nodes);
  const hasPhases = Array.isArray(json.phases);

  if (hasNodes && !hasPhases) {
    // Graph-based 工作流
    return compileGraphWorkflow(json as unknown as WorkflowGraph, source);
  }

  if (hasPhases && !hasNodes) {
    // Phase-based 工作流
    return compileWorkflow(json as unknown as WorkflowJson, source);
  }

  // 两者都有或都没有
  throw new Error('Invalid workflow JSON: must have either "nodes" or "phases"');
}

/**
 * 扫描目录下的所有 .json 工作流文件并注册。
 */
export function scanWorkflowsDir(
  dir: string,
  registry: { register: (def: WorkflowDefinition) => void; registerBuiltin?: (def: WorkflowDefinition) => void },
  source: 'builtin' | 'file' = 'file',
): number {
  if (!existsSync(dir)) return 0;

  let count = 0;
  const entries = readdirSync(dir);

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(dir, entry);
    try {
      const def = loadWorkflowFile(filePath, source);
      if (source === 'builtin' && registry.registerBuiltin) {
        registry.registerBuiltin(def);
      } else {
        registry.register(def);
      }
      count++;
    } catch (err) {
      console.error(`[workflow] Failed to load ${filePath}: ${err}`);
    }
  }

  return count;
}

/**
 * 获取内置工作流目录路径。
 * 优先查找 src 源码目录（开发时），其次 dist 目录（编译后）。
 */
export function getBuiltinWorkflowDir(): string {
  // 从 __dirname (dist/workflow/ 或 src/workflow/) 向上找
  // 开发时 __dirname = dist/workflow/，src 在 ../../src/workflow/
  const srcDir = resolve(__dirname, '..', '..', 'src', 'workflow', 'builtin');
  if (existsSync(srcDir)) return srcDir;
  // 编译后 fallback：dist/workflow/builtin/
  const distDir = resolve(__dirname, 'builtin');
  return distDir;
}

/**
 * 获取用户工作流目录路径。
 */
export function getUserWorkflowDir(): string {
  return resolve(homedir(), '.agent', 'workflows');
}

// ─── Graph-based 工作流导出 ─────────────────────────────────────────

export { compileGraphWorkflow, topologicalSort } from './graph-engine.js';
export type { GraphExecutionContext } from './graph-engine.js';
export type {
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowGraphEdge,
  GraphNodeData,
  WorkflowNodeType,
  NodePort,
} from './graph-types.js';
