import path from 'node:path';
import { GenericRegistry } from './base.js';
import type { SkillDefinition } from '../types.js';
import { loadPrompt, getPromptsDir } from '../prompts/loader.js';
import { loadSkillFile } from '../skills/loader.js';

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

/**
 * 加载**目录式**内置 skill（一个文件夹 ＋ SKILL.md ＋ 子文件）。
 *
 * 为什么单文件内置不够：目录式 skill 的主体里会写「细则见 reference/xxx.md」这类
 * **相对路径**，必须带上 `dir` 才解析得了（见本文件 getFullDefinitions 的 dirNote，
 * 以及 SkillTool 激活时附带的那行 Skill directory）。单文件的 loadPrompt 只返回内容、
 * 不带 dir ⇒ 子文件无从取到。
 *
 * 因此这里复用 skills/loader 的 loadSkillFile —— 它按**同一套** frontmatter 规则解析
 * （含 `>-` 折叠块等，见 loader.ts 文件头记录的历史事故），并把 dir 一并带上。
 * source 覆写为 'builtin'：内置资产随包分发（dist/prompts），仍可被 ~/.agent/skills 里
 * 的**同名文件 skill** 覆盖 —— 文件 skill 后注册，会遮蔽内置（这是有意的覆盖顺序）。
 *
 * ⚠️ 不静默：内置资产缺失 / frontmatter 无 name ⇒ 直接抛（与 loadPrompt 的 throw 语义一致）。
 *    否则这道 skill 会**悄悄少一项**，而 Zone 2 索引里看不出少了什么。
 */
function loadBuiltinDirSkill(name: string, relatedTools: string[]): SkillDefinition {
  const dir = path.join(getPromptsDir(), 'skills', name);
  const main = path.join(dir, 'SKILL.md');
  const skill = loadSkillFile(main, dir);
  if (!skill) throw new Error(`内置目录式 skill 无法加载：${main}（文件缺失或 frontmatter 缺 name）`);
  return { ...skill, relatedTools, source: 'builtin' as const };
}

/** 创建内置 Skill 列表（单文件从 src/prompts/skills/ 加载；目录式见 loadBuiltinDirSkill） */
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
    // ── 目录式内置（一个文件夹 ＋ SKILL.md ＋ 子文件）──
    // 2026-10-10：由 ~/.agent/skills/running-experiments 收编进源码（随包分发，单一真源）。
    // 主体里的细则都在同目录子文件里（reference/*.md、agent-experiment/SKILL.md），
    // 故 relatedTools 只给读类工具；子文件的基准目录由 loadBuiltinDirSkill 写进 dir。
    loadBuiltinDirSkill('running-experiments', ['read', 'glob']),
  ];
}