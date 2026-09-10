import { describe, it, expect, vi, beforeEach } from 'vitest';
import { definePlugin } from './define.js';
import { createPluginApi } from './api.js';
import { PluginLoader } from './loader.js';
import { PluginManager } from './manager.js';
import type { Tool } from '../tools/interface.js';
import type { SkillDefinition } from '../types.js';
import type { ContextSource } from '../context/interface.js';
import type { PluginApi, PluginInstance } from './types.js';

// =============================================================
// definePlugin
// =============================================================

describe('definePlugin', () => {
  it('creates a PluginDefinition with required fields', () => {
    const plugin = definePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      description: 'A test',
      register: vi.fn(),
    });

    expect(plugin.id).toBe('test-plugin');
    expect(plugin.name).toBe('Test Plugin');
    expect(plugin.description).toBe('A test');
    expect(typeof plugin.register).toBe('function');
  });

  it('includes optional lifecycle hooks', () => {
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    const plugin = definePlugin({
      id: 'test',
      name: 'Test',
      description: 'Test',
      register: vi.fn(),
      onActivate,
      onDeactivate,
      configSchema: { type: 'object' },
    });

    expect(plugin.onActivate).toBe(onActivate);
    expect(plugin.onDeactivate).toBe(onDeactivate);
    expect(plugin.configSchema).toEqual({ type: 'object' });
  });
});

// =============================================================
// PluginApi
// =============================================================

describe('createPluginApi', () => {
  const mockToolRegistry = {
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn(),
    getToolDefinitions: vi.fn(),
    has: vi.fn(),
  };

  const mockSkillRegistry = {
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn(() => []),
    getIndex: vi.fn(),
    getFullDefinitions: vi.fn(),
  };

  const mockContextComposer = {
    registerSource: vi.fn(),
    unregisterSource: vi.fn(),
    compose: vi.fn(),
  };

  const onMcpServerRegister = vi.fn();

  function createApi(pluginConfig = {}): PluginApi {
    return createPluginApi({
      pluginId: 'test',
      toolRegistry: mockToolRegistry as any,
      skillRegistry: mockSkillRegistry as any,
      contextComposer: mockContextComposer as any,
      pluginConfig,
      onMcpServerRegister,
      onChannelRegister: vi.fn(),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes pluginId and logger', () => {
    const api = createApi();
    expect(api.pluginId).toBe('test');
    expect(api.logger).toBeDefined();
    expect(typeof api.logger.info).toBe('function');
  });

  it('registerTool delegates to ToolRegistry', () => {
    const api = createApi();
    const tool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: { type: 'object' },
      execute: vi.fn(),
    };

    api.registerTool(tool);
    expect(mockToolRegistry.register).toHaveBeenCalledWith(tool);
  });

  it('registerSkill delegates to SkillRegistry', () => {
    const api = createApi();
    const skill: SkillDefinition = {
      name: 'test-skill',
      description: 'Test skill',
      promptTemplate: 'Do {{thing}}',
      relatedTools: [],
      source: 'file' as const,
    };

    api.registerSkill(skill);
    expect(mockSkillRegistry.register).toHaveBeenCalledWith(skill);
  });

  it('registerContextSource delegates to ContextComposer', () => {
    const api = createApi();
    const source: ContextSource = {
      name: 'test-source',
      strategy: 'index_only',
      cacheability: 'manifest',
      description: 'Test source',
      getContent: () => 'content',
    };

    api.registerContextSource(source);
    expect(mockContextComposer.registerSource).toHaveBeenCalledWith(source);
  });

  it('registerMcpServer calls onMcpServerRegister', () => {
    const api = createApi();
    api.registerMcpServer({ name: 'test-mcp', command: 'echo' });
    expect(onMcpServerRegister).toHaveBeenCalledWith('test', {
      name: 'test-mcp',
      command: 'echo',
    });
  });

  it('getConfig returns plugin config', () => {
    const api = createApi({ apiKey: 'sk-123' });
    expect(api.getConfig()).toEqual({ apiKey: 'sk-123' });
  });

  it('getConfig returns empty object when no config', () => {
    const api = createApi();
    expect(api.getConfig()).toEqual({});
  });
});

// =============================================================
// PluginLoader
// =============================================================

describe('PluginLoader', () => {
  it('scans plugins directory', async () => {
    const loader = new PluginLoader(process.cwd());
    const manifests = await loader.discover();
    expect(Array.isArray(manifests)).toBe(true);
  });

  it('loads no plugins from empty directory', async () => {
    const loader = new PluginLoader('/nonexistent');
    const manifests = await loader.discover();
    expect(manifests).toEqual([]);
  });
});

// =============================================================
// PluginManager
// =============================================================

describe('PluginManager', () => {
  const mockToolRegistry = {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn(() => []),
    getToolDefinitions: vi.fn(() => []),
    has: vi.fn(),
  };

  const mockSkillRegistry = {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn(() => []),
    getIndex: vi.fn(() => ''),
    getFullDefinitions: vi.fn(() => ''),
  };

  const mockContextComposer = {
    registerSource: vi.fn(),
    unregisterSource: vi.fn(),
    compose: vi.fn(),
  };

  function createManager(projectDir: string = process.cwd()) {
    return new PluginManager({
      toolRegistry: mockToolRegistry as any,
      skillRegistry: mockSkillRegistry as any,
      contextComposer: mockContextComposer as any,
      projectDir,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setHooks 追加注入：宿主引用不变、已挂插件不丢（P6-1 修复重建宿主缺陷）', async () => {
    const mgr = createManager('/nonexistent');
    const h1 = mgr.getHost();
    // 先直接挂一个内核级插件（不经目录发现）
    await h1.mount({ id: 'kernel-p1', activate: () => {}, deactivate: () => {} });
    expect(h1.isMounted('kernel-p1')).toBe(true);

    const { createLoopHookBus } = await import('../orchestrator/loop-hooks.js');
    mgr.setHooks(createLoopHookBus());

    // 宿主引用稳定（原实现重建宿主 → 此处红）
    expect(mgr.getHost()).toBe(h1);
    // 已挂插件保留（原实现重建 → 插件被静默丢弃 → 此处红）
    expect(h1.list().map((e) => e.id)).toContain('kernel-p1');

    // 卸载仍有效（状态与真实宿主一致，不再脱节）
    await h1.unmount('kernel-p1');
    expect(h1.isMounted('kernel-p1')).toBe(false);
  });

  it('creates with empty plugin list', () => {
    const mgr = createManager();
    expect(mgr.getAll()).toEqual([]);
  });

  it('loadAll with no plugins does not throw', async () => {
    const mgr = createManager('/nonexistent');
    await expect(mgr.loadAll()).resolves.not.toThrow();
    expect(mgr.getAll()).toEqual([]);
  });

  it('loadAll discovers and loads plugins from project', async () => {
    const mgr = createManager();
    await mgr.loadAll();

    // Should find example-greeter plugin
    const examplePlugin = mgr.get('example-greeter');
    expect(examplePlugin).toBeDefined();
    expect(examplePlugin!.status).toBe('activated');
    expect(examplePlugin!.manifest.name).toBe('Example Greeter');
    expect(examplePlugin!.definition.register).toBeDefined();
  });

  it('getActivated returns only activated plugins', async () => {
    const mgr = createManager();
    await mgr.loadAll();

    const activated = mgr.getActivated();
    expect(activated.length).toBeGreaterThanOrEqual(1);
    for (const p of activated) {
      expect(p.status).toBe('activated');
    }
  });

  // ── P2 改造核心：卸载自动回滚（PluginHost DisposableStore） ──
  it('deactivate auto-rolls-back all registered tools/skills (PluginHost 生命周期)', async () => {
    const mgr = createManager(); // process.cwd() 含 plugins/example-greeter
    await mgr.loadAll();

    const greeter = mgr.get('example-greeter');
    expect(greeter?.status).toBe('activated');
    expect(mockToolRegistry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hello' }));
    expect(mockSkillRegistry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'example-greeter-friendly' }));

    // 卸载 → 自动回滚（无需手动追踪注册项）
    await mgr.deactivate('example-greeter');
    expect(mockToolRegistry.unregister).toHaveBeenCalledWith('hello');
    expect(mockSkillRegistry.unregister).toHaveBeenCalledWith('example-greeter-friendly');
    expect(greeter!.status).toBe('deactivated');
  });

  it('configSchema 校验：required 缺失时激活失败并标记 error', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-schema-test-'));
    const pluginDir = path.join(tmp, 'plugins', 'needs-config');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      id: 'needs-config',
      name: 'Needs Config',
      description: 'Requires apiKey',
      entry: './index.js',
      configSchema: {
        type: 'object',
        properties: { apiKey: { type: 'string' } },
        required: ['apiKey'],
      },
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), `
      export default {
        id: 'needs-config',
        name: 'Needs Config',
        description: 'Requires apiKey',
        register: (api) => { api.logger.info('registered'); },
      };
    `);

    const mgr = createManager(tmp);
    await mgr.loadAll(); // 空配置 → apiKey 缺失 → 校验失败

    const plugin = mgr.get('needs-config');
    expect(plugin?.status).toBe('error');
    expect(plugin?.error).toContain('apiKey');
  });

  // ── 缺口补齐：目录插件经 api.onHook 挂主循环钩子（setHooks 注入总线后） ──
  it('目录插件 api.onHook 挂主循环钩子：setHooks 注入总线后 loadAll 生效', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createLoopHookBus } = await import('../orchestrator/loop-hooks.js');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hook-test-'));
    const pluginDir = path.join(tmp, 'plugins', 'hook-observer');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      id: 'hook-observer',
      name: 'Hook Observer',
      description: 'Observes onTurnStart via api.onHook',
      entry: './index.js',
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), [
      'export default {',
      "  id: 'hook-observer',",
      "  name: 'Hook Observer',",
      "  description: 'Observes onTurnStart',",
      '  register: (api) => {',
      "    api.onHook?.('onTurnStart', (payload) => { globalThis.__hookFired = payload.turn; });",
      '  },',
      '};',
    ].join('\n'));

    const bus = createLoopHookBus();
    const mgr = createManager(tmp);
    mgr.setHooks(bus); // P6-1：追加注入，宿主不重建；插件 activate 期 onHook 需总线已注入
    await mgr.loadAll();

    const plugin = mgr.get('hook-observer');
    expect(plugin?.status).toBe('activated');

    // 触发主循环钩子 → 插件观察者收到
    await bus.emit('onTurnStart', { turn: 7 });
    expect((globalThis as Record<string, unknown>).__hookFired).toBe(7);
    delete (globalThis as Record<string, unknown>).__hookFired;

    // 卸载 → 钩子自动摘除
    await mgr.deactivate('hook-observer');
    await bus.emit('onTurnStart', { turn: 8 });
    expect((globalThis as Record<string, unknown>).__hookFired).toBeUndefined();
  });
});

// =============================================================
// PluginManager — lifecycle
// =============================================================

describe('PluginManager lifecycle', () => {
  it('handles plugin with onActivate and onDeactivate', () => {
    // Test the lifecycle contract via definePlugin
    const activateHook = vi.fn();
    const deactivateHook = vi.fn();
    const registerFn = vi.fn();

    const plugin = definePlugin({
      id: 'lifecycle-test',
      name: 'Lifecycle Test',
      description: 'Tests lifecycle hooks',
      register: registerFn,
      onActivate: activateHook,
      onDeactivate: deactivateHook,
    });

    expect(plugin.onActivate).toBe(activateHook);
    expect(plugin.onDeactivate).toBe(deactivateHook);
    expect(plugin.register).toBe(registerFn);
  });

  it('supports plugin without lifecycle hooks', () => {
    const plugin = definePlugin({
      id: 'minimal',
      name: 'Minimal',
      description: 'Minimal plugin',
      register: vi.fn(),
    });

    expect(plugin.onActivate).toBeUndefined();
    expect(plugin.onDeactivate).toBeUndefined();
  });
});

// =============================================================
// E2E: Plugin registration affects registries
// =============================================================

describe('Plugin integration with registries', () => {
  it('plugin registers tool via api', () => {
    const toolRegistry = { register: vi.fn() } as any;
    const skillRegistry = { register: vi.fn() } as any;
    const contextComposer = { registerSource: vi.fn(), compose: vi.fn() } as any;
    const onMcp = vi.fn();

    const api = createPluginApi({
      pluginId: 'e2e',
      toolRegistry,
      skillRegistry,
      contextComposer,
      pluginConfig: {},
      onMcpServerRegister: onMcp,
      onChannelRegister: vi.fn(),
    });

    const tool: Tool = {
      name: 'e2e-tool',
      description: 'E2E test tool',
      inputSchema: {},
      execute: async () => 'done',
    };

    api.registerTool(tool);
    expect(toolRegistry.register).toHaveBeenCalledWith(tool);
  });

  it('plugin registers skill via api', () => {
    const skillRegistry = { register: vi.fn() } as any;

    const api = createPluginApi({
      pluginId: 'e2e',
      toolRegistry: {} as any,
      skillRegistry,
      contextComposer: {} as any,
      pluginConfig: {},
      onMcpServerRegister: vi.fn(),
      onChannelRegister: vi.fn(),
    });

    const skill: SkillDefinition = {
      name: 'e2e-skill',
      description: 'E2E skill',
      promptTemplate: 'Do {{x}}',
      relatedTools: [],
      source: 'file' as const,
    };

    api.registerSkill(skill);
    expect(skillRegistry.register).toHaveBeenCalledWith(skill);
  });
});