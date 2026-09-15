/**
 * S3 插件热更新闭环 · 集成测试。
 *
 * 用真实 PluginManager + 临时目录 JS 插件走完整链路：
 *   改代码 → handlePluginChange → reloadFromDisk（?t= 破缓存重 import）→ 新版生效；
 *   坏代码 / register 抛错 → 回滚旧版，插件保持可用（recovered=true）；
 *   清单变更 / 无法定位 / 目录删除 → 全量 rescan（幂等 diff）。
 *
 * 44 重启兜底分支（process.exit）不在此触发 —— 升级判定抽为纯函数
 * shouldEscalateToRestart 单测覆盖，exit 路径仅一行接线。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PluginManager } from '../plugins/manager.js';
import { handlePluginChange, resolveChangedPluginId, shouldEscalateToRestart } from './plugin-watcher.js';

// P-Config 收敛后插件统一走全局 ~/.agent/plugins/：mock homedir → 测试临时目录，
// root/.agent/plugins/ 即全局插件目录。homeBox 容器规避 vi.mock 提升期的 TDZ。
const { mockHomedir, homeBox } = vi.hoisted(() => {
  const homeBox = { path: '' };
  return { homeBox, mockHomedir: vi.fn(() => homeBox.path) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, homedir: mockHomedir };
  return { ...mocked, default: mocked };
});

// ── 临时插件源码（JS，免编译；execute 返回版本标记供断言） ──────────

const V1_SRC = `export default {
  id: 'hotplug-p', name: 'Hotplug Probe', description: 'v1',
  register: (api) => {
    api.registerTool({
      name: 'hotplug_probe', description: 'v1', inputSchema: { type: 'object' },
      execute: async () => 'v1',
    });
  },
};
`;

const V2_SRC = `export default {
  id: 'hotplug-p', name: 'Hotplug Probe', description: 'v2',
  register: (api) => {
    api.registerTool({
      name: 'hotplug_probe', description: 'v2', inputSchema: { type: 'object' },
      execute: async () => 'v2',
    });
  },
};
`;

const BROKEN_SRC = `export default { syntax error!!! `;

const REGISTER_THROWS_SRC = `export default {
  id: 'hotplug-p', name: 'Hotplug Probe', description: 'boom',
  register: () => { throw new Error('boom in register'); },
};
`;

const MANIFEST_SRC = JSON.stringify({
  id: 'hotplug-p',
  name: 'Hotplug Probe',
  description: 'hot reload probe',
  entry: './index.js',
  enabledByDefault: true,
});

// ── harness：mock 注册表（记录工具，供执行断言） + 临时项目目录 ──────

interface Harness {
  root: string;
  pluginDir: string;
  mgr: PluginManager;
  deps: { pluginManager: PluginManager; cwd: string; debounceMs: number };
  registeredTools: Map<string, { execute: (args: Record<string, unknown>) => Promise<string> }>;
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'hot-reload-test-'));
  homeBox.path = root; // homedir → root：root/.agent/plugins 即全局插件目录
  const pluginDir = path.join(root, '.agent', 'plugins', 'hotplug-p');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, 'plugin.json'), MANIFEST_SRC, 'utf-8');
  await writeFile(path.join(pluginDir, 'index.js'), V1_SRC, 'utf-8');

  const registeredTools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<string> }>();
  const toolRegistry = {
    register: (t: { name: string; execute: (args: Record<string, unknown>) => Promise<string> }) => registeredTools.set(t.name, t),
    unregister: (name: string) => registeredTools.delete(name),
    get: (name: string) => registeredTools.get(name),
    getAll: () => [...registeredTools.values()],
    getToolDefinitions: () => [...registeredTools.values()].map((t) => ({ name: 'hotplug_probe' })),
    has: (name: string) => registeredTools.has(name),
  };
  const skillRegistry = {
    register: () => {},
    unregister: () => true,
    get: () => undefined,
    getAll: () => [],
    getIndex: () => '',
    getFullDefinitions: () => '',
  };
  const contextComposer = {
    registerSource: () => {},
    unregisterSource: () => {},
    compose: () => [],
  };

  const mgr = new PluginManager({
    toolRegistry: toolRegistry as any,
    skillRegistry: skillRegistry as any,
    contextComposer: contextComposer as any,
    projectDir: root,
  });

  return {
    root,
    pluginDir,
    mgr,
    deps: { pluginManager: mgr, cwd: root, debounceMs: 50 },
    registeredTools,
  };
}

describe('plugin hot reload (S3)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await h.mgr.loadAll();
    expect(h.mgr.get('hotplug-p')?.status).toBe('activated');
    expect(await h.registeredTools.get('hotplug_probe')!.execute({})).toBe('v1');
  });

  afterEach(async () => {
    await rm(h.root, { recursive: true, force: true });
  });

  it('改代码 → 定向热更新生效（?t= 破缓存拿到新代码）', async () => {
    await writeFile(path.join(h.pluginDir, 'index.js'), V2_SRC, 'utf-8');

    const result = await handlePluginChange(h.deps, { filename: 'hotplug-p/index.js', dir: h.pluginDir });

    expect(result).toBe('reloaded');
    expect(await h.registeredTools.get('hotplug_probe')!.execute({})).toBe('v2');
    expect(h.mgr.get('hotplug-p')?.status).toBe('activated');
  });

  it('坏代码（语法错误）→ 回滚旧版，插件保持可用', async () => {
    await writeFile(path.join(h.pluginDir, 'index.js'), V2_SRC, 'utf-8');
    await handlePluginChange(h.deps, { filename: 'hotplug-p/index.js', dir: h.pluginDir });
    expect(await h.registeredTools.get('hotplug_probe')!.execute({})).toBe('v2');

    // 改坏 → 加载失败，旧版未动
    await writeFile(path.join(h.pluginDir, 'index.js'), BROKEN_SRC, 'utf-8');
    const result = await handlePluginChange(h.deps, { filename: 'hotplug-p/index.js', dir: h.pluginDir });
    expect(result).toBe('rolled-back');
    expect(await h.registeredTools.get('hotplug_probe')!.execute({})).toBe('v2');
  });

  it('register 抛错（激活失败）→ 自动回滚旧版，插件保持可用', async () => {
    await writeFile(path.join(h.pluginDir, 'index.js'), REGISTER_THROWS_SRC, 'utf-8');
    const result = await handlePluginChange(h.deps, { filename: 'hotplug-p/index.js', dir: h.pluginDir });

    expect(result).toBe('rolled-back');
    expect(h.mgr.get('hotplug-p')?.status).toBe('activated');
    expect(await h.registeredTools.get('hotplug_probe')!.execute({})).toBe('v1');
  });

  it('清单变更 / 无法定位插件 → 全量 rescan', async () => {
    await writeFile(path.join(h.pluginDir, 'plugin.json'), MANIFEST_SRC, 'utf-8');
    await expect(handlePluginChange(h.deps, { filename: 'hotplug-p/plugin.json', dir: h.pluginDir }))
      .resolves.toBe('rescanned');

    // poll 模式（filename=null）无法定位
    await expect(handlePluginChange(h.deps, { filename: null, dir: h.pluginDir }))
      .resolves.toBe('rescanned');

    // 未知插件目录（新增插件的目录级事件）
    await expect(handlePluginChange(h.deps, { filename: 'brand-new/index.js', dir: h.pluginDir }))
      .resolves.toBe('rescanned');
  });

  it('插件目录整体删除 → rescan 注销插件与工具', async () => {
    await rm(h.pluginDir, { recursive: true, force: true });

    const result = await handlePluginChange(h.deps, { filename: 'hotplug-p/index.js', dir: h.pluginDir });

    expect(result).toBe('rescanned');
    expect(h.mgr.get('hotplug-p')).toBeUndefined();
    expect(h.registeredTools.has('hotplug_probe')).toBe(false);
  });
});

describe('plugin-watcher pure helpers', () => {
  it('resolveChangedPluginId：首段即插件目录名（兼容 \\ 与 /）', () => {
    expect(resolveChangedPluginId({ filename: 'example-greeter/index.js', dir: 'x' })).toBe('example-greeter');
    expect(resolveChangedPluginId({ filename: 'example-greeter\\sub\\a.js', dir: 'x' })).toBe('example-greeter');
    expect(resolveChangedPluginId({ filename: null, dir: 'x' })).toBeNull();
  });

  it('shouldEscalateToRestart：仅「回滚失败 + guardian 守护下」升级', () => {
    const saved = process.env.HYACINTH_GUARDIAN_CHILD;
    try {
      delete process.env.HYACINTH_GUARDIAN_CHILD;
      expect(shouldEscalateToRestart(false)).toBe(false);
      expect(shouldEscalateToRestart(true)).toBe(false);

      process.env.HYACINTH_GUARDIAN_CHILD = '1';
      expect(shouldEscalateToRestart(false)).toBe(true);
      expect(shouldEscalateToRestart(true)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.HYACINTH_GUARDIAN_CHILD;
      else process.env.HYACINTH_GUARDIAN_CHILD = saved;
    }
  });
});
