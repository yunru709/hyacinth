/**
 * Skill → Workflow 转换工具（模型专用）
 *
 * 让模型在判断某个 Skill 适合以 Workflow 方式执行时，
 * 自动将其转换为 Workflow 定义。
 *
 * 用户不需要手动调用此工具。转换后原 Skill 继续可用。
 */

import type { Tool } from '../tools/interface.js';
import type { SkillRegistry } from '../registry/skill.registry.js';
import type { WorkflowRegistry } from './registry.js';
import type { WorkflowManager } from './manager.js';
import type { WorkflowDefinition } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function createConvertSkillToWorkflowTool(
  skillRegistry: SkillRegistry,
  workflowRegistry: WorkflowRegistry,
  workflowManager: WorkflowManager,
): Tool {
  return {
    name: 'convert_skill_to_workflow',
    description:
      'Convert a Skill into a structured Workflow for step-by-step execution. ' +
      'Use this when a task would benefit from tracked progress and state management. ' +
      'The original Skill remains available. This tool is for model use only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skill_name: {
          type: 'string' as const,
          description: 'Name of the Skill to convert to a Workflow',
        },
        decompose: {
          type: 'boolean' as const,
          description: 'If true, attempt to decompose the Skill prompt into multiple steps (default: false, single-step)',
        },
        activate: {
          type: 'boolean' as const,
          description: 'If true, immediately activate the converted Workflow (default: true)',
        },
      },
      required: ['skill_name'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const skillName = args.skill_name as string;
      const decompose = args.decompose as boolean ?? false;
      const activate = args.activate as boolean ?? true;

      // 1. 查找 Skill
      const skill = skillRegistry.get(skillName);
      if (!skill) {
        const available = skillRegistry.getAll().map(s => s.name).join(', ');
        return `Error: Skill "${skillName}" not found. Available skills: [${available}]`;
      }

      // 2. 检查是否已有同名 Workflow
      if (workflowRegistry.has(skillName)) {
        // 已存在，直接激活（如果需要）
        if (activate) {
          try {
            workflowManager.activate(skillName, { task: skill.description });
            return `Workflow "${skillName}" already exists (from previous conversion). Activated.`;
          } catch (err) {
            return `Workflow "${skillName}" exists but activation failed: ${(err as Error).message}`;
          }
        }
        return `Workflow "${skillName}" already exists (from previous conversion). Use workflow({action:"activate", name:"${skillName}"}) to activate.`;
      }

      // 3. 生成步骤
      let steps: Array<{ id: number; name: string; description: string }>;

      if (decompose) {
        // 尝试从 promptTemplate 中解析步骤结构
        steps = extractStepsFromPrompt(skill.promptTemplate, skillName);
      } else {
        // 单步：整个 Skill 作为一个步骤
        steps = [{
          id: 1,
          name: skillName,
          description: skill.description,
        }];
      }

      // 4. 构建 WorkflowDefinition
      const def: WorkflowDefinition = {
        name: skillName,
        description: `Converted from Skill: ${skill.description}`,
        source: 'converted',
        relatedTools: skill.relatedTools,
        triggerKeywords: [skillName, skill.description],

        createState(_params) {
          return {
            name: skillName,
            data: {
              ..._params,
              skillPrompt: skill.promptTemplate,
            },
            steps: steps.map(s => ({ ...s, status: 'pending' as const })),
            startedAt: new Date().toISOString(),
          };
        },

        handleStep(state, action) {
          if (!action.id) return null;
          const stepIdx = state.steps.findIndex(s => s.id === action.id);
          if (stepIdx === -1) return null;

          const newSteps = [...state.steps];
          switch (action.action) {
            case 'done':
              newSteps[stepIdx] = { ...newSteps[stepIdx], status: 'completed' };
              const next = newSteps.findIndex(
                (s, i) => i > stepIdx && s.status === 'pending',
              );
              if (next !== -1) newSteps[next] = { ...newSteps[next], status: 'in_progress' };
              break;
            case 'blocked':
              newSteps[stepIdx] = { ...newSteps[stepIdx], status: 'blocked', reason: action.message };
              break;
            case 'add':
              if (action.description) {
                newSteps.push({
                  id: newSteps.length > 0 ? Math.max(...newSteps.map(s => s.id)) + 1 : 1,
                  name: action.description,
                  description: action.description,
                  status: 'pending',
                });
              }
              break;
            default:
              break;
          }

          const allDone = newSteps.every(s => s.status === 'completed');
          return {
            newState: { ...state, steps: newSteps },
            result: {
              workflow: skillName,
              progress: `Step ${action.id} ${action.action}.`,
              allDone,
              nextStep: allDone ? undefined : newSteps.find(s => s.status === 'pending' || s.status === 'in_progress'),
            },
          };
        },

        renderForInjection(state) {
          const prompt = (state.data as Record<string, unknown>).skillPrompt as string ?? skill.promptTemplate;
          const progress = state.steps.map(s => {
            const m = s.status === 'completed' ? '[x]' : s.status === 'blocked' ? '[🚫]' : s.status === 'in_progress' ? '[▶]' : '[ ]';
            return `  ${m} ${s.description}`;
          }).join('\n');

          return `## Workflow: ${skillName} (from Skill)

**描述**: ${skill.description}

**Skill 提示词**:
${prompt}

**进度**:
${progress}

使用 \`workflow({action:"step", ...})\` 推进步骤。`;
        },

        isComplete(state) {
          return state.steps.length > 0 && state.steps.every(s => s.status === 'completed');
        },
      };

      // 5. 保存 YAML 文件
      try {
        const workflowsDir = path.join(os.homedir(), '.agent', 'workflows');
        if (!fs.existsSync(workflowsDir)) fs.mkdirSync(workflowsDir, { recursive: true });

        const yamlContent = generateYaml(def, steps);
        fs.writeFileSync(
          path.join(workflowsDir, `${skillName}.yaml`),
          yamlContent,
          'utf-8',
        );
      } catch {
        // 文件写入失败不阻塞注册
      }

      // 6. 注册到 WorkflowRegistry
      workflowRegistry.register(def);

      // 7. 激活（如果需要）
      if (activate) {
        try {
          workflowManager.activate(skillName, { task: skill.description });
          return `Skill "${skillName}" converted to Workflow with ${steps.length} step(s) and activated.\n` +
            `Original Skill remains available via use_skill.`;
        } catch (err) {
          return `Skill "${skillName}" converted to Workflow with ${steps.length} step(s).\n` +
            `Activation failed: ${(err as Error).message}\n` +
            `Use workflow({action:"activate", name:"${skillName}"}) to activate.`;
        }
      }

      return `Skill "${skillName}" converted to Workflow with ${steps.length} step(s).\n` +
        `Use workflow({action:"activate", name:"${skillName}"}) to activate.\n` +
        `Original Skill remains available via use_skill.`;
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** 从 promptTemplate 中提取步骤结构（简单启发式） */
function extractStepsFromPrompt(
  prompt: string,
  skillName: string,
): Array<{ id: number; name: string; description: string }> {
  const steps: Array<{ id: number; name: string; description: string }> = [];

  // 寻找编号列表：1. / 2. / Step 1: / First: 等模式
  const patterns = [
    /(?:^|\n)\s*(?:Step\s*)?(\d+)[\.:]\s*(.+)/gi,
    /(?:^|\n)\s*(?:First|Second|Third|Finally)[,:]\s*(.+)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(prompt)) !== null) {
      const text = match[2] ?? match[1];
      if (text) {
        steps.push({
          id: steps.length + 1,
          name: text.trim().slice(0, 80),
          description: text.trim(),
        });
      }
    }
    if (steps.length > 0) break;
  }

  if (steps.length === 0) {
    steps.push({ id: 1, name: skillName, description: `Execute the ${skillName} skill` });
  }

  return steps;
}

/** 转义 YAML 字符串中的特殊字符 */
function escapeYamlValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/** 生成 YAML 文件内容 */
function generateYaml(
  def: WorkflowDefinition,
  steps: Array<{ id: number; name: string; description: string }>,
): string {
  const lines: string[] = [
    `# Workflow: ${def.name} (converted from Skill)`,
    `name: ${def.name}`,
    `description: "${escapeYamlValue(def.description)}"`,
    `triggerKeywords: [${(def.triggerKeywords ?? []).join(', ')}]`,
    `relatedTools: [${(def.relatedTools ?? []).join(', ')}]`,
    `steps:`,
  ];

  for (const step of steps) {
    lines.push(`  - id: ${step.id}`);
    lines.push(`    name: "${escapeYamlValue(step.name)}"`);
    lines.push(`    description: "${escapeYamlValue(step.description)}"`);
  }

  return lines.join('\n') + '\n';
}
