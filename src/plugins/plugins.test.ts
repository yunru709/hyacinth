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
    get: vi.fn(),
    getAll: vi.fn(() => []),
    getToolDefinitions: vi.fn(() => []),
    has: vi.fn(),
  };

  const mockSkillRegistry = {
    register: vi.fn(),
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