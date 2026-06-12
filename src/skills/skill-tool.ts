import type { Tool } from '../tools/interface.js';
import type { SkillRegistry } from './registry.js';

/**
 * SkillTool — 将 Skill 的 promptTemplate 渲染为工具执行结果
 *
 * 当 LLM 选择使用某个 Skill 时，调用此工具获取渲染后的提示词，
 * 然后将结果注入到后续对话中。
 *
 * 实现 Tool 接口，可直接注册到 ToolRegistry。
 */
export class SkillTool implements Tool {
  readonly name = 'use_skill';
  readonly description = 'Activate a skill by name. Returns the skill\'s rendered prompt template for use in the conversation.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      skill_name: {
        type: 'string',
        description: 'Name of the skill to activate',
      },
      variables: {
        type: 'object',
        description: 'Variables to substitute in the skill\'s prompt template (e.g. {"code": "...", "error": "..."})',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['skill_name'],
  };

  private registry: SkillRegistry;

  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  /** 执行 Skill 调用 */
  async execute(input: Record<string, unknown>): Promise<string> {
    const skillName = input.skill_name as string;
    const variables = (input.variables as Record<string, string>) ?? {};

    const skill = this.registry.get(skillName);
    if (!skill) {
      return `Error: Unknown skill "${skillName}". Available skills: ${this.registry.getAll().map(s => s.name).join(', ')}`;
    }

    // 渲染模板：替换 {{variable}} 占位符
    let rendered = skill.promptTemplate;
    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replaceAll(`{{${key}}}`, value);
    }

    // 清理未替换的占位符
    rendered = rendered.replaceAll(/\{\{(\w+)\}\}/g, '($1)');

    return rendered;
  }
}
