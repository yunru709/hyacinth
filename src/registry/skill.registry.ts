import { GenericRegistry } from './base.js';
import type { SkillDefinition } from '../types.js';
import { loadPrompt } from '../prompts/loader.js';

/**
 * Skill 注册表
 * 负责注册、查询 Skill，以及生成索引/完整定义文本
 *
 * 支持启用/禁用（enable/disable）机制：
 * - disable() 可作用于任意 skill，将其标记为不可用
 * - enable() 恢复被禁用的 skill
 * - get() / getAll() / getIndex() / getFullDefinitions() 均会跳过已禁用的 skill
 * - unregister() 允许注销任意 skill（包括内置的）
 *
 * SkillDefinition 已包含 name 和 source，结构上满足 RegistryItem 约束。
 */
export class SkillRegistry extends GenericRegistry<SkillDefinition> {
  private builtins = new Map<string, SkillDefinition>();

  constructor() {
    super();
  }

  /** 注册内置 Skill 并保存快照，用于文件覆盖删除后恢复 */
  registerBuiltin(skill: SkillDefinition): void {
    this.builtins.set(skill.name, { ...skill });
    this.register(skill);
  }

  /** 注销后如果存在同名内置快照则自动恢复 */
  unregister(name: string): boolean {
    const deleted = super.unregister(name);
    if (deleted) {
      const builtin = this.builtins.get(name);
      if (builtin) {
        this.register({ ...builtin });
      }
    }
    return deleted;
  }

  // ── 索引 / 定义 ──────────────────────────────────────────────

  /** 获取索引格式（名称+描述列表），用于 Zone 2 manifest */
  getIndex(): string {
    const skills = this.getAll();
    if (skills.length === 0) return '';
    return 'Available skills:\n' + skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
  }

  /** 获取指定 Skill 列表的完整定义文本（跳过已禁用的） */
  getFullDefinitions(names: string[]): string {
    return names
      .map(name => this.items.get(name))
      .filter((s): s is SkillDefinition => s != null && !this._disabled.has(s.name))
      .map((s) => {
        // 目录式 skill：连"子文件在哪儿"一并交代 ⇒ 主体里的相对路径才解析得了 ✓
        const dirNote = s.dir
          ? '\nSkill directory: ' + s.dir +
            '\n(该 skill 的子文件都在此目录下；主体里给出的相对路径以它为基准，需要细节时用 read 工具取 ✓)'
          : '';
        return '[Skill: ' + s.name + ']\nDescription: ' + s.description +
          '\nRelated Tools: ' + s.relatedTools.join(', ') + dirNote +
          '\nPrompt Template:\n' + s.promptTemplate;
      })
      .join('\n\n');
  }

  // ── 向后兼容别名 ──────────────────────────────────────────────

  /** @deprecated 使用 enable() 替代 */
  enableSkill(name: string): void {
    this.enable(name);
  }

  /** @deprecated 使用 disable() 替代 */
  disableSkill(name: string): void {
    this.disable(name);
  }
}

/** 创建内置 Skill 列表（内容从 src/prompts/skills/ 加载） */
export function createBuiltinSkills(): SkillDefinition[] {
  return [
    {
      name: 'code-review',
      description: 'Review code for bugs, style issues, and best practices',
      promptTemplate: loadPrompt('skills/code-review'),
      relatedTools: ['read', 'glob'],
      source: 'builtin' as const,
    },
    {
      name: 'debug',
      description: 'Debug an issue by analyzing error messages and tracing code paths',
      promptTemplate: loadPrompt('skills/debug'),
      relatedTools: ['read', 'bash', 'glob'],
      source: 'builtin' as const,
    },
    {
      name: 'refactor',
      description: 'Refactor code to improve structure, readability, and maintainability',
      promptTemplate: loadPrompt('skills/refactor'),
      relatedTools: ['read', 'edit', 'glob'],
      source: 'builtin' as const,
    },
    {
      name: 'framework-reference',
      description: 'Agent 框架配置指南 — 配置项、旁路Agent、模型通道等框架能力说明',
      promptTemplate: loadPrompt('skills/framework-reference'),
      relatedTools: ['get_config', 'update_config', 'list_model_channels', 'model_channel_info', 'config_schema'],
      source: 'builtin' as const,
    },
  ];
}