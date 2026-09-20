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

describe('loader 目录式 skill（一个文件夹 ＋ SKILL.md ＋ 子文件 ✓）', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-dir-'));
  });

  it('目录式：从 <name>/SKILL.md 载入，并带上 dir（相对路径的基准 ✓）', () => {
    const d = path.join(root, 'folder-skill');
    fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: folder-skill\ndescription: 目录式\n---\n\n主体内容\n\n细则见 references/a.md\n', 'utf-8');
    fs.writeFileSync(path.join(d, 'references', 'a.md'), '细则 A\n', 'utf-8');

    const reg = new SkillRegistry();
    expect(scanSkillsDir(root, reg)).toEqual(['folder-skill']);
    const s = reg.get('folder-skill');
    expect(s?.promptTemplate).toContain('主体内容');
    expect(s?.dir).toBe(d);
  });

  it('**子文件不会被当成独立 skill**（关键负向判据 ✓）', () => {
    const d = path.join(root, 'x');
    fs.mkdirSync(path.join(d, 'references', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: x\ndescription: d\n---\nbody\n', 'utf-8');
    fs.writeFileSync(path.join(d, 'references', 'a.md'), '---\nname: a\ndescription: 不该被注册\n---\nX\n', 'utf-8');
    fs.writeFileSync(path.join(d, 'references', 'deep', 'b.md'), '---\nname: b\ndescription: 也不该\n---\nY\n', 'utf-8');

    const reg = new SkillRegistry();
    scanSkillsDir(root, reg);
    expect(reg.getAll().map((s) => s.name)).toEqual(['x']);
  });

  it('单文件 .md 仍可用（向后兼容 ✓），且不带 dir', () => {
    fs.writeFileSync(path.join(root, 'flat.md'), '---\nname: flat\ndescription: 单文件\n---\nbody\n', 'utf-8');
    const reg = new SkillRegistry();
    expect(scanSkillsDir(root, reg)).toEqual(['flat']);
    expect(reg.get('flat')?.dir).toBeUndefined();
  });

  it('目录里没有 SKILL.md ⇒ 不注册也不炸 ✓', () => {
    fs.mkdirSync(path.join(root, 'noentry', 'sub'), { recursive: true });
    const reg = new SkillRegistry();
    expect(scanSkillsDir(root, reg)).toEqual([]);
  });
});
