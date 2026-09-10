/**
 * skill-registry.test.ts —— SkillRegistry 单测（M3 补护航：报告误判「空壳」，
 * 实际实现完整但 0 测试）。
 *
 * 覆盖 SkillRegistry：注册/查询/启用禁用/索引与完整定义（禁用跳过）/
 * registerBuiltin 注销恢复内置/createBuiltinSkills 内置清单/loader frontmatter。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry, createBuiltinSkills } from './registry.js';
import { loadSkillFile, scanSkillsDir } from './loader.js';
import type { SkillDefinition } from '../types.js';

function makeSkill(name: string, over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `desc-${name}`,
    promptTemplate: `template-${name}`,
    relatedTools: ['read'],
    source: 'file',
    ...over,
  };
}

describe('SkillRegistry 技能注册表', () => {
  let reg: SkillRegistry;
  beforeEach(() => {
    reg = new SkillRegistry();
  });

  it('注册与查询：register/get/getAll', () => {
    reg.register(makeSkill('a'));
    reg.register(makeSkill('b'));
    expect(reg.get('a')?.description).toBe('desc-a');
    expect(reg.getAll().map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('disable 后 get/getAll 跳过，enable 恢复', () => {
    reg.register(makeSkill('a'));
    reg.disable('a');
    expect(reg.get('a')).toBeUndefined();
    expect(reg.getAll()).toHaveLength(0);
    expect(reg.getDisabled().map((s) => s.name)).toEqual(['a']);
    reg.enable('a');
    expect(reg.get('a')).toBeDefined();
  });

  it('registerBuiltin 后 unregister 自动恢复内置快照', () => {
    reg.registerBuiltin(makeSkill('builtin-x', { source: 'builtin' }));
    // 文件覆盖删除 → unregister → 内置恢复
    expect(reg.unregister('builtin-x')).toBe(true);
    expect(reg.get('builtin-x')?.source).toBe('builtin');
  });

  it('getIndex 列出已启用技能，getFullDefinitions 跳过禁用', () => {
    reg.register(makeSkill('a', { relatedTools: ['read', 'glob'] }));
    reg.register(makeSkill('b'));
    reg.disable('b');
    const index = reg.getIndex();
    expect(index).toContain('a');
    expect(index).not.toContain('desc-b');
    const defs = reg.getFullDefinitions(['a', 'b']);
    expect(defs).toContain('desc-a');
    expect(defs).not.toContain('desc-b');
  });

  it('createBuiltinSkills 返回内置技能清单（含 framework-reference）', () => {
    const skills = createBuiltinSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain('code-review');
    expect(names).toContain('debug');
    expect(names).toContain('refactor');
    expect(names).toContain('framework-reference');
    for (const s of skills) {
      expect(s.promptTemplate.length).toBeGreaterThan(0); // loadPrompt 已加载
      expect(s.source).toBe('builtin');
    }
  });
});

describe('skills/loader 加载器', () => {
  it('loadSkillFile 解析 YAML frontmatter 与正文', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    const file = path.join(dir, 'my-skill.md');
    fs.writeFileSync(file, [
      '---',
      'name: my-skill',
      'description: 我的技能',
      'tools: read, bash',
      '---',
      '正文模板 {{input}}',
    ].join('\n'));
    try {
      const skill = loadSkillFile(file);
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('my-skill');
      expect(skill!.description).toBe('我的技能');
      expect(skill!.promptTemplate).toContain('正文模板');
      expect(skill!.relatedTools).toContain('read');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scanSkillsDir 扫描目录并注册技能到 registry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scan-'));
    fs.writeFileSync(path.join(dir, 'one.md'), '---\nname: one\ndescription: d1\ntools:\n---\nbody1');
    fs.writeFileSync(path.join(dir, 'two.md'), '---\nname: two\ndescription: d2\ntools:\n---\nbody2');
    fs.writeFileSync(path.join(dir, 'ignore.txt'), 'not a skill');
    const reg = new SkillRegistry();
    try {
      const loaded = scanSkillsDir(dir, reg);
      expect(loaded.sort()).toEqual(['one', 'two']);
      expect(reg.get('one')?.description).toBe('d1');
      expect(reg.get('two')).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
