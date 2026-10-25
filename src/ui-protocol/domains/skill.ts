// ============================================================
// UI 契约层 — 技能域（skill.*）
// ============================================================
// 覆盖 UI 对 SkillRegistry 的管理面：
//   skill.list    列出全部技能（含已禁用），带描述/来源/关联工具/启用状态
//   skill.get     读取单个技能的完整提示词（用于详情抽屉）
//   skill.toggle  启用/禁用技能，并持久化 skills.disabled
//
// 与 tool 域同一模式：只依赖最小结构接口（闭包延迟解析），
// 不把 UI 契约层绑死到 SkillRegistry 具体实现。
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 最小接口（SkillDefinition 天然满足）
// ────────────────────────────────────────────────────────────

export interface SkillEntryLike {
  name: string;
  description?: string;
  promptTemplate?: string;
  relatedTools?: string[];
  /** 'builtin' | 'file' | 'plugin' | 'mcp' | 'user' */
  source?: string;
  /** 目录式技能的基准目录（子文件都在这里） */
  dir?: string;
}

export interface SkillRegistryLike {
  /** 已启用 */
  getAll(): SkillEntryLike[];
  /** 已禁用 */
  getDisabled(): SkillEntryLike[];
  has(name: string): boolean;
  isEnabled(name: string): boolean;
  enable(name: string): void;
  disable(name: string): void;
}

export interface SkillDomainOptions {
  getSkillRegistry: () => SkillRegistryLike | null;
  /** 持久化禁用列表；缺省只改内存（与会话同生命周期） */
  persistDisabled?: (names: string[]) => void | Promise<void>;
}

/** skill.list 的单条结果 */
export interface SkillView {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  relatedTools: string[];
  /** 目录式技能：给 UI 一个「这技能带子文件」的提示 */
  hasDir: boolean;
}

function findSkill(registry: SkillRegistryLike, name: string): SkillEntryLike | undefined {
  return (
    registry.getAll().find((s) => s.name === name) ??
    registry.getDisabled().find((s) => s.name === name)
  );
}

function toView(skill: SkillEntryLike, enabled: boolean): SkillView {
  return {
    name: skill.name,
    description: skill.description ?? '',
    source: skill.source ?? 'builtin',
    enabled,
    relatedTools: skill.relatedTools ?? [],
    hasDir: !!skill.dir,
  };
}

// ────────────────────────────────────────────────────────────
// 技能域工厂
// ────────────────────────────────────────────────────────────

export function createSkillDomain(options: SkillDomainOptions): DomainHandler {
  const { getSkillRegistry, persistDisabled } = options;

  return {
    // ── skill.list ─────────────────────────────────────────
    async list(): Promise<{ skills: SkillView[] }> {
      const registry = getSkillRegistry();
      if (!registry) throw new Error('skill.list not supported (skill registry not available)');
      const enabled = registry.getAll().map((s) => toView(s, true));
      const disabled = registry.getDisabled().map((s) => toView(s, false));
      // 已启用优先，其次按名称排序 —— UI 不用再排一遍
      const skills = [...enabled.sort((a, b) => a.name.localeCompare(b.name)), ...disabled.sort((a, b) => a.name.localeCompare(b.name))];
      return { skills };
    },

    // ── skill.get ──────────────────────────────────────────
    async get(params: unknown): Promise<{ skill: SkillView & { promptTemplate: string; dir?: string } }> {
      const { name } = (params as { name?: string } | undefined) ?? {};
      if (!name) throw new Error('skill.get requires "name"');
      const registry = getSkillRegistry();
      if (!registry) throw new Error('skill.get not supported (skill registry not available)');
      const skill = findSkill(registry, name);
      if (!skill) throw new Error(`skill "${name}" not found`);
      return {
        skill: {
          ...toView(skill, registry.isEnabled(name)),
          promptTemplate: skill.promptTemplate ?? '',
          ...(skill.dir ? { dir: skill.dir } : {}),
        },
      };
    },

    // ── skill.toggle ───────────────────────────────────────
    async toggle(params: unknown): Promise<{ ok: true; name: string; enabled: boolean }> {
      const { name, enabled } = (params as { name?: string; enabled?: boolean } | undefined) ?? {};
      if (!name) throw new Error('skill.toggle requires "name"');
      if (typeof enabled !== 'boolean') throw new Error('skill.toggle requires "enabled" (boolean)');
      const registry = getSkillRegistry();
      if (!registry) throw new Error('skill.toggle not supported (skill registry not available)');
      if (!registry.has(name)) throw new Error(`skill "${name}" not found`);

      if (enabled) registry.enable(name);
      else registry.disable(name);

      const disabledNames = registry.getDisabled().map((s) => s.name);
      await persistDisabled?.(disabledNames);
      return { ok: true, name, enabled };
    },
  };
}
