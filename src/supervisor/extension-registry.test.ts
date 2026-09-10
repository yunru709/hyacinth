import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REPLACEABLE_POINTS,
  getReplaceablePoint,
  parseExtensionManifest,
  mergeManifests,
  loadExtensionManifest,
  emptyManifest,
  ExtensionRegistry,
} from './extension-registry.js';

describe('可替换点目录', () => {
  it('id 全部唯一且形如 <kind>:<name>', () => {
    const ids = REPLACEABLE_POINTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of REPLACEABLE_POINTS) {
      expect(p.id).toMatch(new RegExp(`^${p.kind}:`));
      expect(p.description).toBeTruthy();
    }
  });

  it('精确命中 + 动态族回退', () => {
    expect(getReplaceablePoint('slot:llm')?.kind).toBe('slot');
    expect(getReplaceablePoint('tool:read')?.id).toBe('tool:*');
    expect(getReplaceablePoint('channel:feishu')?.id).toBe('channel:*');
    expect(getReplaceablePoint('nonexistent:foo')).toBeUndefined();
    expect(getReplaceablePoint('no-colon')).toBeUndefined();
  });
});

describe('名单解析 parseExtensionManifest', () => {
  it('完整合法名单解析通过', () => {
    const { manifest, errors } = parseExtensionManifest({
      replacements: [{ point: 'provider:main', impl: 'my-provider', module: './modules/my-provider.js' }],
      plugins: [
        { id: 'example-greeter', mountAt: 'loop-hook:beforeToolExecute', enabled: true },
        { id: 'my-world', enabled: false },
      ],
      orders: [{ point: 'source:memory', order: ['plugin-a', 'memory'] }],
    });
    expect(errors).toEqual([]);
    expect(manifest.replacements).toHaveLength(1);
    expect(manifest.plugins).toHaveLength(2);
    expect(manifest.orders).toHaveLength(1);
  });

  it('非法条目剔除并记错，合法条目保留', () => {
    const { manifest, errors } = parseExtensionManifest({
      replacements: [
        { point: 'provider:unknown-point', impl: 'x' },      // 目录无此点
        { point: 'provider:main', impl: '' },                 // 缺 impl
        { point: 'provider:main', impl: 'ok', module: 'abs.js' }, // module 必须相对路径
        { point: 'provider:main', impl: 'good', module: './m.js' },
      ],
      plugins: [
        { id: '', enabled: true },          // 缺 id
        { id: 'p1', enabled: 'yes' },       // enabled 非布尔
        { id: 'p2', enabled: false },
      ],
      orders: [{ point: 'tool:read', order: [] }],
    });
    expect(errors).toHaveLength(6);
    expect(manifest.replacements).toEqual([{ point: 'provider:main', impl: 'good', module: './m.js' }]);
    expect(manifest.plugins).toEqual([{ id: 'p2', enabled: false }]);
    expect(manifest.orders).toEqual([]);
  });

  it('非对象根 / 缺段 → 空名单', () => {
    expect(parseExtensionManifest(null).manifest).toEqual(emptyManifest());
    expect(parseExtensionManifest('nope').errors).toHaveLength(1);
    expect(parseExtensionManifest({}).manifest).toEqual(emptyManifest());
  });
});

describe('两层名单合并 mergeManifests', () => {
  it('项目级按主键覆盖全局级，其余并集', () => {
    const g = {
      replacements: [{ point: 'provider:main', impl: 'global-impl' }],
      plugins: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }],
      orders: [{ point: 'tool:*', order: ['x'] }],
    };
    const p = {
      replacements: [{ point: 'provider:main', impl: 'project-impl' }],
      plugins: [{ id: 'b', enabled: false }],
      orders: [],
    };
    const m = mergeManifests(g, p);
    expect(m.replacements).toEqual([{ point: 'provider:main', impl: 'project-impl' }]);
    expect(m.plugins).toEqual([{ id: 'a', enabled: true }, { id: 'b', enabled: false }]);
    expect(m.orders).toEqual([{ point: 'tool:*', order: ['x'] }]);
  });
});

describe('名单加载 loadExtensionManifest', () => {
  it('文件缺失 → 空名单零错误', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reg-'));
    // 隔离：临时改写 homedir，避免真实 ~/.agent/extension-registry.json 污染「空名单」断言
    const realHomedir = os.homedir();
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reg-home-'));
    const origHomedir = Object.getOwnPropertyDescriptor(os, 'homedir');
    (os as any).homedir = () => fakeHome;
    try {
      const { manifest, errors } = loadExtensionManifest(dir);
      expect(manifest).toEqual(emptyManifest());
      expect(errors).toEqual([]);
    } finally {
      if (origHomedir) Object.defineProperty(os, 'homedir', origHomedir);
      else (os as any).homedir = () => realHomedir;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('项目级覆盖全局级；坏 JSON 记错不炸', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reg-'));
    fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
    fs.mkdirSync(path.join(os.homedir(), '.agent'), { recursive: true });
    const globalPath = path.join(os.homedir(), '.agent', 'extension-registry.json');
    const projectPath = path.join(dir, '.agent', 'extension-registry.json');
    const hadGlobal = fs.existsSync(globalPath);
    const savedGlobal = hadGlobal ? fs.readFileSync(globalPath, 'utf-8') : null;
    try {
      fs.writeFileSync(globalPath, JSON.stringify({ plugins: [{ id: 'greeter', enabled: true }] }));
      fs.writeFileSync(projectPath, JSON.stringify({ plugins: [{ id: 'greeter', enabled: false }] }));
      const { manifest, errors } = loadExtensionManifest(dir);
      expect(errors).toEqual([]);
      expect(manifest.plugins).toEqual([{ id: 'greeter', enabled: false }]);

      fs.writeFileSync(projectPath, '{ broken');
      const bad = loadExtensionManifest(dir);
      expect(bad.errors).toHaveLength(1);
      expect(bad.manifest.plugins).toEqual([{ id: 'greeter', enabled: true }]); // 回退全局层
    } finally {
      if (hadGlobal) fs.writeFileSync(globalPath, savedGlobal!);
      else fs.rmSync(globalPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('运行时注册表 ExtensionRegistry', () => {
  it('裁决：名单显式声明 > fallback', () => {
    const reg = new ExtensionRegistry();
    reg.setManifest({
      replacements: [],
      plugins: [{ id: 'on-plugin', enabled: true }, { id: 'off-plugin', enabled: false }],
      orders: [],
    });
    expect(reg.adjudicatePluginEnabled('on-plugin', false)).toBe(true);
    expect(reg.adjudicatePluginEnabled('off-plugin', true)).toBe(false);
    expect(reg.adjudicatePluginEnabled('undeclared', true)).toBe(true);
    expect(reg.adjudicatePluginEnabled('undeclared', false)).toBe(false);
  });

  it('替换申请与排序声明透出', () => {
    const reg = new ExtensionRegistry();
    reg.setManifest({
      replacements: [{ point: 'provider:main', impl: 'my-provider', module: './m.js' }],
      plugins: [],
      orders: [{ point: 'source:memory', order: ['plugin-x', 'memory'] }],
    });
    expect(reg.getReplacements()).toEqual([{ point: 'provider:main', impl: 'my-provider', module: './m.js' }]);
    expect(reg.getOrder('source:memory')).toEqual(['plugin-x', 'memory']);
    expect(reg.getOrder('source:flow')).toBeUndefined();
    expect(reg.getPluginDecl('on-plugin')).toBeUndefined();
  });

  it('record upsert + list 过滤 + describe 展示', () => {
    const reg = new ExtensionRegistry();
    reg.setManifest({ replacements: [{ point: 'provider:main', impl: 'my-provider' }], plugins: [], orders: [] });
    reg.record({ point: 'provider:main', source: 'user', impl: 'my-provider', replacedFrom: 'builtin:deepseek', enabled: true, effective: true });
    reg.record({ point: 'plugin:greeter', source: 'plugin', impl: 'greeter@1.0.0', mountAt: 'tool', enabled: true, effective: false, error: 'mount failed' });
    expect(reg.list()).toHaveLength(2);
    expect(reg.list('plugin')).toHaveLength(1);
    expect(reg.get('provider:main')?.replacedFrom).toBe('builtin:deepseek');
    const text = reg.describe();
    expect(text).toContain('✓ provider:main');
    expect(text).toContain('replaces builtin:deepseek');
    expect(text).toContain('✗ plugin:greeter');
    expect(text).toContain('mount failed');
  });

  it('未应用的名单声明在 describe 中标记 declared, not applied', () => {
    const reg = new ExtensionRegistry();
    reg.setManifest({ replacements: [{ point: 'provider:main', impl: 'my-provider' }], plugins: [], orders: [] });
    expect(reg.describe()).toContain('declared, not applied');
  });
});

describe('插件架构申报与同点多来源裁决', () => {
  it('单插件申报 → 该点赢家为插件（source: plugin，moduleBase=插件目录）', () => {
    const reg = new ExtensionRegistry();
    reg.submitPluginArchitecture({
      pluginId: 'companion',
      priority: 100,
      points: [{ point: 'slot:context', impl: 'companion:ctx', module: './mods/ctx.js' }],
      dir: '/plugins/companion',
    });
    const r = reg.resolvePoint('slot:context');
    expect(r?.source).toBe('plugin');
    expect(r?.decl).toEqual({ point: 'slot:context', impl: 'companion:ctx', module: './mods/ctx.js' });
    expect(r?.moduleBase).toBe('/plugins/companion');
  });

  it('多插件同点 → priority 高者生效（败者被压掉）', () => {
    const reg = new ExtensionRegistry();
    reg.submitPluginArchitecture({ pluginId: 'low', priority: 10, points: [{ point: 'slot:llm', impl: 'low:llm' }] });
    reg.submitPluginArchitecture({ pluginId: 'high', priority: 200, points: [{ point: 'slot:llm', impl: 'high:llm' }] });
    const r = reg.resolvePoint('slot:llm');
    expect(r?.decl.impl).toBe('high:llm');
    expect(r?.source).toBe('plugin');
  });

  it('同 priority → 插件 id 字典序小者生效（确定性 tie-break，永不歧义）', () => {
    const reg = new ExtensionRegistry();
    reg.submitPluginArchitecture({ pluginId: 'zeta', priority: 0, points: [{ point: 'source:memory', impl: 'zeta:mem' }] });
    reg.submitPluginArchitecture({ pluginId: 'alpha', priority: 0, points: [{ point: 'source:memory', impl: 'alpha:mem' }] });
    const r = reg.resolvePoint('source:memory');
    expect(r?.decl.impl).toBe('alpha:mem');
  });

  it('用户名单（source: user）决定性压过一切插件声明', () => {
    const reg = new ExtensionRegistry();
    reg.setManifest({
      replacements: [{ point: 'service:compressor', impl: 'user:compressor', module: './u.js' }],
      plugins: [],
      orders: [],
    });
    reg.submitPluginArchitecture({ pluginId: 'companion', priority: 999, points: [{ point: 'service:compressor', impl: 'companion:comp' }] });
    const r = reg.resolvePoint('service:compressor');
    expect(r?.source).toBe('user');
    expect(r?.decl.impl).toBe('user:compressor');
    expect(r?.moduleBase).toBeUndefined(); // user 名单模块相对 cwd
  });

  it('无任何申报 → undefined（走 builtin 基线）', () => {
    const reg = new ExtensionRegistry();
    expect(reg.resolvePoint('slot:input')).toBeUndefined();
    expect(reg.resolvePoint('provider:main')).toBeUndefined();
  });

  it('目录不可命中的点宽容剔除（记日志不炸）', () => {
    const reg = new ExtensionRegistry();
    reg.submitPluginArchitecture({
      pluginId: 'bad',
      priority: 0,
      points: [{ point: 'slot:context', impl: 'ok:ctx' }, { point: 'slot:nonexistent', impl: 'nope' }],
    });
    expect(reg.listPluginArchitectures()[0].points).toEqual([{ point: 'slot:context', impl: 'ok:ctx' }]);
    expect(reg.resolvePoint('slot:nonexistent')).toBeUndefined();
  });

  it('getResolvedReplacements：user + 插件赢家并集，每个 point 至多一条', () => {
    const reg = new ExtensionRegistry();
    reg.setManifest({
      replacements: [{ point: 'router:normal', impl: 'user:router', module: './r.js' }],
      plugins: [],
      orders: [],
    });
    reg.submitPluginArchitecture({ pluginId: 'a', priority: 5, points: [{ point: 'agent:helper', impl: 'a:helper' }] });
    reg.submitPluginArchitecture({ pluginId: 'b', priority: 10, points: [{ point: 'agent:helper', impl: 'b:helper' }, { point: 'slot:bypass', impl: 'b:bypass' }] });
    const resolved = reg.getResolvedReplacements();
    const byPoint = new Map(resolved.map((r) => [r.decl.point, r]));
    expect(byPoint.size).toBe(3);
    expect(byPoint.get('router:normal')?.source).toBe('user');
    expect(byPoint.get('router:normal')?.decl.impl).toBe('user:router');
    expect(byPoint.get('agent:helper')?.decl.impl).toBe('b:helper');   // priority 10 胜 5
    expect(byPoint.get('slot:bypass')?.decl.impl).toBe('b:bypass');    // 单申报直接生效
  });

  it('同名插件重复申报 = 覆盖（最后一次生效）', () => {
    const reg = new ExtensionRegistry();
    reg.submitPluginArchitecture({ pluginId: 'p', priority: 0, points: [{ point: 'slot:tools', impl: 'p:v1' }] });
    reg.submitPluginArchitecture({ pluginId: 'p', priority: 0, points: [{ point: 'slot:tools', impl: 'p:v2' }] });
    expect(reg.resolvePoint('slot:tools')?.decl.impl).toBe('p:v2');
  });
});
