// ============================================================
// 声明式模式 profile 测试：钩子注册表 / DeclarativeRouter / 加载器
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerModeHook } from './mode-profile.js';
import { DeclarativeRouter, type ModeProfile } from './mode-profile.js';
import { loadModeProfiles } from './mode-profile-loader.js';
import { getRouterByName } from './profiles.js';
import type { ResolverContext } from './section-resolver.js';

describe('DeclarativeRouter（声明式模式）', () => {
  it('静态部分直接读 profile：工具面 / 过滤 / 覆写', () => {
    const router = new DeclarativeRouter({
      name: 'test-static',
      toolAllowlist: ['read'],
      toolBlacklist: ['bash'],
      skipSections: ['tool_rules'],
      skipRuntimeSources: ['skills'],
      sourceOverrides: { persona_soul: { source: 'prompts/persona/PartnerSoul', append: '引导' } },
    });
    expect(router.name).toBe('test-static');
    expect(router.toolAllowlist).toEqual(['read']);
    expect(router.toolBlacklist).toEqual(['bash']);
    expect(router.skipSections).toEqual(['tool_rules']);
    expect(router.skipRuntimeSources).toEqual(['skills']);
    expect(router.sourceOverrides['persona_soul']?.source).toBe('prompts/persona/PartnerSoul');
    expect(router.sourceOverrides['persona_soul']?.append).toBe('引导');
    // 无钩子的模式：历史/输入均原样
    expect(router.filterHistory?.([{ role: 'user', content: 'x' } as never])).toEqual([
      { role: 'user', content: 'x' } as never,
    ]);
  });

  it('resolveHook：sourceOverrides.resolve 经具名钩子接管', async () => {
    registerModeHook('test-resolve-persona', async () => '钩子产出的 persona');
    const router = new DeclarativeRouter({
      name: 'test-hook-resolve',
      sourceOverrides: { persona_soul: { resolveHook: 'test-resolve-persona' } },
    });
    const resolved = await router.sourceOverrides['persona_soul']?.resolve?.({} as ResolverContext);
    expect(resolved).toBe('钩子产出的 persona');
  });

  it('transformUserInput / materializeHistory 经具名钩子生效', async () => {
    registerModeHook('test-transform', async (u: string) => `[${u}]`);
    registerModeHook('test-materialize', ((raw: unknown[]) => raw.slice(0, 1)) as never);
    const router = new DeclarativeRouter({
      name: 'test-hooks',
      hooks: { transformUserInput: 'test-transform', materializeHistory: 'test-materialize' },
    });
    await expect(router.transformUserInput!('hi', null)).resolves.toBe('[hi]');
    const raw = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] as never[];
    expect(router.materializeHistory!(raw)).toHaveLength(1);
  });

  it('onActivate：resolveSession 切 session + bypassMode 激活旁路；onPostTurn 按 profile 清理', async () => {
    const calls: string[] = [];
    registerModeHook('test-resolve-session', async () => '/tmp/mode-session');
    const router = new DeclarativeRouter({
      name: 'test-lifecycle',
      hooks: { resolveSession: 'test-resolve-session' },
      bypassMode: 'test-bypass',
      postTurnCleanup: ['erase-tool-rounds', 'erase-task-trigger'],
    });
    const loop = {
      sessionDir: '/tmp/normal',
      switchSession: async (d: string) => calls.push(`switch:${d}`),
      setActiveUserId: (id: string) => calls.push(`uid:${id}`),
      bypassManager: {
        activateForMode: async (m: string) => calls.push(`bypass:${m}`),
        deactivateAll: async () => calls.push('bypass:off'),
      },
      eraseLastToolRoundJsonl: async () => calls.push('erase-round'),
      removeTaskTriggerJsonl: async () => calls.push('erase-trigger'),
    };
    await router.onActivate!(loop);
    expect(calls).toContain('switch:/tmp/mode-session');
    expect(calls).toContain('bypass:test-bypass');

    await router.onPostTurn!(loop, null, true);
    expect(calls).toContain('erase-round');
    expect(calls).not.toContain('erase-trigger');

    await router.onPostTurn!(loop, 'task-a', false);
    expect(calls).toContain('erase-trigger');
  });

  it('getTaskPrompt：模板渲染与缺省', () => {
    const tpl = new DeclarativeRouter({ name: 't1', taskPrompt: '处理 {{task}}' });
    expect(tpl.getTaskPrompt('整理')).toBe('处理 整理');
    const dflt = new DeclarativeRouter({ name: 't2' });
    expect(dflt.getTaskPrompt('x')).toContain('x');
  });
});

describe('loadModeProfiles（加载器）', () => {
  let tmp = '';
  let homeBackup = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-test-'));
    homeBackup = process.env.USERPROFILE ?? process.env.HOME ?? '';
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    void homeBackup;
  });

  it('全局 + 项目目录：注册进 Router 注册表，项目同名覆盖全局', () => {
    // 用临时目录当 home：全局 modes/
    const globalDir = path.join(tmp, 'home', '.agent', 'modes');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'test-load-global.json'), JSON.stringify({
      description: '全局版',
      skipSections: ['tool_rules'],
    }));
    // 项目 modes/：同名覆盖 + 新增
    const projectDir = path.join(tmp, 'project', '.agent', 'modes');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test-load-global.json'), JSON.stringify({
      description: '项目覆盖版',
      skipSections: ['attention'],
    }));
    fs.writeFileSync(path.join(projectDir, 'test-load-project.json'), JSON.stringify({
      toolAllowlist: ['read'],
    }));

    // loader 读 home 与 cwd —— 用临时目录当 home（os.homedir() 每次读 USERPROFILE/HOME env）
    process.env.USERPROFILE = path.join(tmp, 'home');
    process.env.HOME = path.join(tmp, 'home');
    // os.homedir() 在进程内缓存 env 于启动时？Node 的 os.homedir() 每次读 env（Windows: USERPROFILE）
    const loaded = loadModeProfiles(path.join(tmp, 'project'));

    expect(loaded).toContain('test-load-global');
    expect(loaded).toContain('test-load-project');
    const router = getRouterByName('test-load-global') as DeclarativeRouter | undefined;
    expect(router).toBeDefined();
    expect(router?.description).toBe('项目覆盖版');
    expect(router?.skipSections).toEqual(['attention']);
    const projectRouter = getRouterByName('test-load-project') as DeclarativeRouter | undefined;
    expect(projectRouter?.toolAllowlist).toEqual(['read']);
  });

  it('坏 JSON 跳过不阻塞（其余 profile 照常注册）', () => {
    const projectDir = path.join(tmp, 'p2', '.agent', 'modes');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'test-load-bad.json'), '{ not json');
    fs.writeFileSync(path.join(projectDir, 'test-load-good.json'), JSON.stringify({}));
    process.env.USERPROFILE = path.join(tmp, 'no-home');
    process.env.HOME = path.join(tmp, 'no-home');
    const loaded = loadModeProfiles(path.join(tmp, 'p2'));
    expect(loaded).toContain('test-load-good');
    expect(loaded).not.toContain('test-load-bad');
    expect(getRouterByName('test-load-good')).toBeDefined();
  });
});
