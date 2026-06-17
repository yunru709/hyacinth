import { GenericRegistry } from '../registry/base.js';
import type { WorkflowDefinition } from './types.js';

/**
 * WorkflowRegistry — 工作流注册表
 *
 * 负责注册、查询 Workflow，生成索引/完整定义文本。
 * 继承 GenericRegistry，与 SkillRegistry 共用一个基类。
 *
 * 特性：
 * - registerBuiltin() 保存快照，用于文件覆盖删除后自动恢复
 * - unregister() override：删除后若存在同名内置快照则自动恢复
 * - getIndex() 生成 Zone 2 manifest 文本
 * - isBuiltin() 用于名称保护区（防止用户意外覆盖内置 Workflow）
 */
export class WorkflowRegistry extends GenericRegistry<WorkflowDefinition> {
  private builtins = new Map<string, WorkflowDefinition>();

  constructor() {
    super();
  }

  /** 注册内置 Workflow 并保存快照，用于文件覆盖删除后恢复 */
  registerBuiltin(def: WorkflowDefinition): void {
    this.builtins.set(def.name, { ...def });
    this.register(def);
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

  // ── 查询 ─────────────────────────────────────────────────────────

  /** 是否为内置 Workflow（受名称保护） */
  isBuiltin(name: string): boolean {
    return this.builtins.has(name);
  }

  /** 获取所有内置 Workflow 名称 */
  getBuiltinNames(): string[] {
    return [...this.builtins.keys()];
  }

  // ── 索引 / 定义 ──────────────────────────────────────────────────

  /** 获取索引格式（名称+描述列表），用于 Zone 2 manifest */
  getIndex(): string {
    const workflows = this.getAll();
    if (workflows.length === 0) return '';

    return 'Available workflows:\n' + workflows.map(w => {
      const fromSkill = w.source === 'converted' ? ' (from skill)' : '';
      return `- ${w.name}: ${w.description}${fromSkill}`;
    }).join('\n');
  }

  /** 获取指定 Workflow 列表的完整定义文本（跳过已禁用的） */
  getFullDefinitions(names: string[]): string {
    return names
      .map(name => this.items.get(name))
      .filter((w): w is WorkflowDefinition => w != null && !this._disabled.has(w.name))
      .map(w => {
        const tools = w.relatedTools?.join(', ') ?? '(none)';
        const triggers = w.triggerKeywords?.join(', ') ?? '(none)';
        return `[Workflow: ${w.name}]\nDescription: ${w.description}\nSource: ${w.source}\nTriggers: ${triggers}\nRelated Tools: ${tools}`;
      })
      .join('\n\n');
  }
}
