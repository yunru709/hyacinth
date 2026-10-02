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
  readonly description = '按名称激活技能。返回该技能渲染后的提示词模板，供对话中使用。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      skill_name: {
        type: 'string',
        description: '要激活的技能名称',
      },
      variables: {
        type: 'object',
        description: '在技能提示词模板中替换的变量（示例：{"code": "...", "error": "..."}）',
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

    // 目录式 skill：激活时把子文件目录一并给出 ✓
    // （否则主体里「细则见 references/x.md」这类相对路径无从解析 ✗）
    const dirNote = skill.dir
      ? '\n\n---\nSkill directory: ' + skill.dir +
        '\n(子文件都在此目录下；主体里给出的相对路径以它为基准，按需用 read 工具取 ✓)'
      : '';

    return rendered + dirNote;
  }
}
