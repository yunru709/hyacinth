import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowDefinition, WorkflowStep, WorkflowState } from './types.js';
import type { WorkflowRegistry } from './registry.js';

// ─── Simple YAML Parser ───────────────────────────────────────────────

interface ParsedWorkflow {
  name?: string;
  description?: string;
  triggerKeywords?: string[];
  relatedTools?: string[];
  steps?: WorkflowStep[];
}

/**
 * 解析 YAML 中的数组值 `[a, b, c]` 或裸逗号分隔值
 */
function parseArrayValue(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    return inner.split(',').map(s => s.trim()).filter(Boolean);
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * 简单 YAML 解析器：
 * - 顶层 key: value（单值或数组）
 * - steps 块：缩进的 `- id: N` / `  name: ...` / `  description: ...`
 *
 * 只覆盖 workflow 定义所需的子集，不处理嵌套 map / 多级缩进 / 引号转义。
 */
function parseWorkflowYaml(content: string): ParsedWorkflow {
  const result: ParsedWorkflow = { steps: [] };
  const lines = content.split('\n');

  let inSteps = false;
  let currentStep: Partial<WorkflowStep> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // 跳过空行和纯注释
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    // 检测 steps 块开始
    if (line.trim() === 'steps:') {
      inSteps = true;
      continue;
    }

    if (inSteps) {
      // 解析步骤项：  - id: N
      if (line.match(/^\s*-\s+id:\s*(\d+)/)) {
        // 保存前一个步骤
        if (currentStep && currentStep.id !== undefined && currentStep.name) {
          result.steps!.push({
            id: currentStep.id,
            name: currentStep.name,
            description: currentStep.description || currentStep.name,
            status: 'pending',
          });
        }
        const idMatch = line.match(/^\s*-\s+id:\s*(\d+)/);
        currentStep = { id: parseInt(idMatch![1], 10), status: 'pending' };
        continue;
      }
      // 解析步骤属性：    name: ... / description: ...
      if (currentStep) {
        const propMatch = line.match(/^\s+(\w+):\s*(.+)/);
        if (propMatch) {
          const [, key, value] = propMatch;
          if (key === 'name') currentStep.name = value.trim().replace(/^["']|["']$/g, '');
          else if (key === 'description') currentStep.description = value.trim().replace(/^["']|["']$/g, '');
        }
        continue;
      }
      // 非步骤行退出 steps 块
      inSteps = false;
    }

    // 顶层 key: value（单值或数组）
    const match = line.match(/^(\w+):\s*(.+)/);
    if (!match) continue;

    const [, key, value] = match;
    switch (key) {
      case 'name':
        result.name = value.trim();
        break;
      case 'description':
        result.description = value.trim();
        break;
      case 'triggerKeywords':
        result.triggerKeywords = parseArrayValue(value);
        break;
      case 'relatedTools':
        result.relatedTools = parseArrayValue(value);
        break;
    }
  }

  // 保存最后一个步骤
  if (currentStep && currentStep.id !== undefined && currentStep.name) {
    result.steps!.push({
      id: currentStep.id,
      name: currentStep.name,
      description: currentStep.description || currentStep.name,
      status: 'pending',
    });
  }

  return result;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * 从 .yaml 文件加载一个 workflow 定义
 */
export function loadWorkflowFile(filePath: string): WorkflowDefinition | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseWorkflowYaml(content);

    if (!parsed.name) return null;

    const steps = parsed.steps ?? [];
    // 若无步骤定义，创建一个默认单步
    const finalSteps: WorkflowStep[] = steps.length > 0
      ? steps
      : [{
          id: 1,
          name: parsed.name,
          description: parsed.description || parsed.name,
          status: 'pending',
        }];

    return {
      name: parsed.name,
      description: parsed.description || parsed.name,
      source: 'file',
      relatedTools: parsed.relatedTools,
      triggerKeywords: parsed.triggerKeywords,

      createState(_params: Record<string, unknown>) {
        return {
          name: parsed.name!,
          data: { ..._params },
          steps: finalSteps.map(s => ({ ...s })),
          startedAt: new Date().toISOString(),
        };
      },

      handleStep(state, action) {
        if (!action.id || !action.action) return null;

        const stepIdx = state.steps.findIndex(s => s.id === action.id);
        if (stepIdx === -1) return null;

        const newSteps = [...state.steps];

        switch (action.action) {
          case 'done':
            newSteps[stepIdx] = { ...newSteps[stepIdx], status: 'completed' };
            // auto-advance next pending
            const nextPending = newSteps.findIndex(
              (s, i) => i > stepIdx && s.status === 'pending',
            );
            if (nextPending !== -1) {
              newSteps[nextPending] = { ...newSteps[nextPending], status: 'in_progress' };
            }
            break;
          case 'blocked':
            newSteps[stepIdx] = {
              ...newSteps[stepIdx],
              status: 'blocked',
              reason: action.message,
            };
            break;
          case 'add':
            if (action.description) {
              const newId = newSteps.length > 0
                ? Math.max(...newSteps.map(s => s.id)) + 1
                : 1;
              newSteps.push({
                id: newId,
                name: action.description,
                description: action.description,
                status: 'pending',
              });
            }
            break;
          case 'note':
          case 'progress':
            // no state change
            break;
          default:
            return null;
        }

        const allDone = newSteps.every(s => s.status === 'completed');
        const progress = renderStepProgress(newSteps);

        return {
          newState: { ...state, steps: newSteps },
          result: {
            workflow: state.name,
            progress,
            allDone,
            nextStep: allDone ? undefined : newSteps.find(s => s.status === 'pending' || s.status === 'in_progress'),
          },
        };
      },

      renderForInjection(state) {
        return renderWorkflowPrompt(state, finalSteps);
      },

      isComplete(state) {
        return state.steps.length > 0 && state.steps.every(s => s.status === 'completed');
      },
    };
  } catch {
    return null;
  }
}

/**
 * 扫描目录中的 .yaml workflow 文件并注册它们
 */
export function scanWorkflowsDir(
  dir: string,
  registry: WorkflowRegistry,
): string[] {
  const loaded: string[] = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const filePath = path.join(dir, entry);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const def = loadWorkflowFile(filePath);
      if (def) {
        // 内置名保护区：不允许文件直接覆盖内置 Workflow
        if (registry.isBuiltin(def.name)) {
          // 跳过——内置名受保护。用户需要先手动 unregister 再注册自定义版本
          continue;
        }
        registry.register(def);
        loaded.push(def.name);
      }
    }
  } catch {
    // 目录不存在
  }
  return loaded;
}

// ─── Shared Helpers ────────────────────────────────────────────────────

/** 渲染步骤进度列表（含 emoji 标记） */
function renderStepProgress(steps: WorkflowStep[]): string {
  return steps.map(s => {
    const marker =
      s.status === 'completed' ? '[x]' :
      s.status === 'blocked' ? '[🚫]' :
      s.status === 'in_progress' ? '[▶]' :
      '[ ]';
    const reason = s.status === 'blocked' && s.reason ? ` — ${s.reason}` : '';
    return `${marker} ${s.description}${reason}`;
  }).join('\n');
}

/** 渲染 Workflow 注入提示词 */
function renderWorkflowPrompt(
  state: WorkflowState,
  _steps: WorkflowStep[],
): string {
  const current = state.steps.find(
    (s: WorkflowStep) => s.status === 'in_progress' || s.status === 'pending',
  );
  const progress = renderStepProgress(state.steps);
  const currentLine = current
    ? `\n**Current Step**: ${current.id}. ${current.description}`
    : '';

  return `## Workflow: ${state.name}

**Progress**:
${progress}
${currentLine}

Use \`workflow({action:"step", id:N, stepAction:"done"})\` to mark steps complete.
Use \`workflow({action:"step", id:N, stepAction:"blocked", message:"reason"})\` to mark blocked.`;
}
