// ============================================================
// UI 契约层 — 技能域测试
// ============================================================
// 覆盖：
//  1. skill.list 同时返回启用与禁用技能（管理面不能只看到启用项）
//  2. skill.get 返回完整提示词 / 目录
//  3. skill.toggle 启停并持久化 skills.disabled
//  4. 注册表缺失时明确报错
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createSkillDomain, type SkillRegistryLike } from './skill.js';
import type { UiResponse } from '../types.js';

interface MockSkill {
  name: string;
  description: string;
  promptTemplate: string;
  relatedTools: string[];
  source: string;
  dir?: string;
}

function makeSkillRegistry(): SkillRegistryLike {
  const items: MockSkill[] = [
    { name: 'code-review', description: '审查代码', promptTemplate: '# review', relatedTools: ['read'], source: 'builtin' },
    {
      name: 'running-experiments',
      description: '实验流程',
      promptTemplate: '# experiments',
      relatedTools: ['read', 'glob'],
      source: 'builtin',
      dir: 'C:/prompts/skills/running-experiments',
    },
  ];
  const disabled = new Set<string>();

  return {
    getAll: () => items.filter((s) => !disabled.has(s.name)),
    getDisabled: () => items.filter((s) => disabled.has(s.name)),
    has: (n) => items.some((s) => s.name === n),
    isEnabled: (n) => items.some((s) => s.name === n) && !disabled.has(n),
    enable: (n) => disabled.delete(n),
    disable: (n) => disabled.add(n),
  };
}

function setup(overrides: { skill?: SkillRegistryLike | null } = {}) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  const skill = overrides.skill === undefined ? makeSkillRegistry() : overrides.skill;
  const persisted: string[][] = [];
  server.registerDomain('skill', createSkillDomain({
    getSkillRegistry: () => skill,
    persistDisabled: (names) => { persisted.push([...names]); },
  }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const request = async (id: string, method: string, params?: unknown): Promise<UiResponse> => {
    client.send({ kind: 'request', id, method, params } as never);

    const start = Date.now();
    while (Date.now() - start < 2000) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout: ${method}`);
  };
  return { request, persisted };
}

describe('skill domain', () => {
  it('skill.list 同时返回启用与禁用技能', async () => {
    const { request } = setup();
    await request('r1', 'skill.toggle', { name: 'code-review', enabled: false });
    const res = await request('r2', 'skill.list');
    expect(res.ok).toBe(true);
    const skills = (res.result as { skills: Array<{ name: string; enabled: boolean }> }).skills;
    expect(skills).toHaveLength(2);
    expect(skills.find((s) => s.name === 'code-review')?.enabled).toBe(false);
    expect(skills.find((s) => s.name === 'running-experiments')?.enabled).toBe(true);
  });

  it('skill.get 返回提示词与技能目录', async () => {
    const { request } = setup();
    const res = await request('r1', 'skill.get', { name: 'running-experiments' });
    expect(res.ok).toBe(true);
    const detail = (res.result as { skill: { promptTemplate: string; dir?: string; hasDir: boolean } }).skill;
    expect(detail.promptTemplate).toBe('# experiments');
    expect(detail.dir).toBe('C:/prompts/skills/running-experiments');
    expect(detail.hasDir).toBe(true);
  });

  it('skill.toggle 持久化禁用列表', async () => {
    const { request, persisted } = setup();
    const res = await request('r1', 'skill.toggle', { name: 'code-review', enabled: false });
    expect(res.ok).toBe(true);
    expect(persisted[persisted.length - 1]).toEqual(['code-review']);

    await request('r2', 'skill.toggle', { name: 'code-review', enabled: true });
    expect(persisted[persisted.length - 1]).toEqual([]);
  });

  it('注册表缺失时报错', async () => {
    const { request } = setup({ skill: null });
    const res = await request('r1', 'skill.list');
    expect(res.ok).toBe(false);
  });
});
