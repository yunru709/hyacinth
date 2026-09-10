import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createArchRegistries,
  applyProviderReplacement,
  applySourceReplacements,
  applyAgentReplacements,
  applyRouterReplacements,
  applySlotReplacements,
  applyServiceReplacements,
  STAGE_SERVICE_KEYS,
} from './arch-assembly.js';
import { switchRouter, getActiveRouterName } from '../context/profiles.js';
import type { Provider } from '../provider/interface.js';

// =============================================================
// 架构监督装配（扩展注册表方案阶段 4）
// =============================================================

let tmpDir = '';

/** 写测试名单与用户替换模块（纯 ESM .js，沿用插件入口约定） */
function setupManifest(manifest: unknown, moduleCode?: string): string {
  fs.mkdirSync(path.join(tmpDir, '.agent'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.agent', 'extension-registry.json'),
    JSON.stringify(manifest),
  );
  if (moduleCode !== undefined) {
    fs.mkdirSync(path.join(tmpDir, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'modules', 'test-provider.js'), moduleCode);
  }
  return path.join(tmpDir, 'modules', 'test-provider.js');
}

/** 写自定义文件名的用户模块（多 kind 分发表测试用） */
function writeUserModule(filename: string, code: string): string {
  fs.mkdirSync(path.join(tmpDir, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'modules', filename), code);
  return `./modules/${filename}`;
}

/** 内置主通道替身（getMainProvider 的返回值） */
function builtinProvider(): Provider {
  return {
    createStream: async function* () { /* 未被调用 */ },
    getProviderType: () => 'deepseek' as never,
    getModel: () => 'builtin-test-model',
  } as unknown as Provider;
}

/** 捕获 setMainProvider 的通道注册表替身 */
function fakeChannelRegistry() {
  let main = builtinProvider();
  return {
    setMainProvider(p: Provider) { main = p; },
    getMainProvider: () => main,
    get current() { return main; },
  };
}

/** 用户替换模块（与 fixture 文件等价的内联版本，供断言参照） */
const USER_MODULE_CODE = `
export default function createProvider({ cwd }) {
  return {
    createStream: async function* () {},
    getProviderType: () => 'user',
    getModel: () => 'user-model',
    cwdMarker: cwd,
  };
}
`;

describe('createArchRegistries', () => {
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-asm-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('本体注册表收编三处装配记录（图/槽位/服务），id 唯一', () => {
    const { assemblyRegistry } = createArchRegistries({ cwd: tmpDir, pipeline: [{ id: 'input', impl: 'builtin:input-normalize' }] });
    expect(assemblyRegistry.list('slot').map((e) => e.id)).toEqual(['slot:input']);
    expect(assemblyRegistry.list('service')).toHaveLength(STAGE_SERVICE_KEYS.length);
    expect(assemblyRegistry.list('instance').length + assemblyRegistry.list('plugin').length + assemblyRegistry.list('shared-ref').length + assemblyRegistry.list('phase').length).toBeGreaterThan(0);
    expect(assemblyRegistry.get('service:compressor')).toBeDefined();
  });

  it('扩展注册表加载名单；缺名单文件为空名单', () => {
    const empty = createArchRegistries({ cwd: tmpDir });
    expect(empty.extensionRegistry.getReplacements()).toEqual([]);

    setupManifest({ replacements: [{ point: 'provider:main', impl: 'my-provider', module: './modules/test-provider.js' }] });
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    expect(extensionRegistry.getReplacements()).toEqual([
      { point: 'provider:main', impl: 'my-provider', module: './modules/test-provider.js' },
    ]);
  });
});

describe('applyProviderReplacement（provider:main 真实替换点端到端）', () => {
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-asm-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('名单声明 → 动态装载用户模块 → 取代出厂主通道（生效记录 + replacedFrom）', async () => {
    setupManifest(
      { replacements: [{ point: 'provider:main', impl: 'my-provider', module: './modules/test-provider.js' }] },
      USER_MODULE_CODE,
    );
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const registry = fakeChannelRegistry();

    await applyProviderReplacement({ cwd: tmpDir, extensionRegistry, channelRegistry: registry });

    const entry = extensionRegistry.get('provider:main');
    expect(entry?.effective).toBe(true);
    expect(entry?.source).toBe('user');
    expect(entry?.replacedFrom).toBe('deepseek/builtin-test-model');
    expect((registry.current as unknown as { getModel(): string }).getModel()).toBe('user-model');
  });

  it('无名单声明 → 原样不动（零替换零记录）', async () => {
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const registry = fakeChannelRegistry();
    await applyProviderReplacement({ cwd: tmpDir, extensionRegistry, channelRegistry: registry });
    expect(extensionRegistry.get('provider:main')).toBeUndefined();
    expect((registry.current as unknown as { getModel(): string }).getModel()).toBe('builtin-test-model');
  });

  it('模块路径不存在 → effective=false + error，出厂主通道保持', async () => {
    setupManifest({ replacements: [{ point: 'provider:main', impl: 'missing', module: './modules/nope.js' }] });
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const registry = fakeChannelRegistry();

    await applyProviderReplacement({ cwd: tmpDir, extensionRegistry, channelRegistry: registry });

    const entry = extensionRegistry.get('provider:main');
    expect(entry?.effective).toBe(false);
    expect(entry?.error).toBeTruthy();
    expect((registry.current as unknown as { getModel(): string }).getModel()).toBe('builtin-test-model');
  });

  it('导出不是 Provider 形状 → effective=false + error', async () => {
    setupManifest(
      { replacements: [{ point: 'provider:main', impl: 'bad-shape', module: './modules/test-provider.js' }] },
      'export default { hello: true };\n',
    );
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const registry = fakeChannelRegistry();

    await applyProviderReplacement({ cwd: tmpDir, extensionRegistry, channelRegistry: registry });

    const entry = extensionRegistry.get('provider:main');
    expect(entry?.effective).toBe(false);
    expect(entry?.error).toContain('Provider-shaped');
    expect((registry.current as unknown as { getModel(): string }).getModel()).toBe('builtin-test-model');
  });
});

// =============================================================
// 多 kind 分发表（阶段 4.2）：source / agent / router / slot / service
// =============================================================

describe('多 kind 分发表（source/agent/router/slot/service）', () => {
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-asm-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function manifestWith(point: string, filename: string): void {
    fs.mkdirSync(path.join(tmpDir, '.agent'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agent', 'extension-registry.json'),
      JSON.stringify({ replacements: [{ point, impl: 'user-impl', module: filename }] }),
    );
  }

  it('source: → registerSource 同名覆盖内置源，记录生效 + replacedFrom', async () => {
    manifestWith('source:memory', writeUserModule('src.js', `
      export default { name: 'memory', strategy: 'fixed', cacheability: 'fixed', getContent: async () => ({ blocks: [] }) };
    `));
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const registerSource = vi.fn();
    await applySourceReplacements({ cwd: tmpDir, extensionRegistry, composer: { registerSource } as never });

    expect(registerSource).toHaveBeenCalledTimes(1);
    const entry = extensionRegistry.get('source:memory');
    expect(entry?.effective).toBe(true);
    expect(entry?.replacedFrom).toBe('builtin');
  });

  it('source: 导出不是 ContextSource 形状 → effective=false，不注册', async () => {
    manifestWith('source:memory', writeUserModule('bad-src.js', 'export default { hello: 1 };\n'));
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const registerSource = vi.fn();
    await applySourceReplacements({ cwd: tmpDir, extensionRegistry, composer: { registerSource } as never });

    expect(registerSource).not.toHaveBeenCalled();
    expect(extensionRegistry.get('source:memory')?.effective).toBe(false);
    expect(extensionRegistry.get('source:memory')?.error).toContain('ContextSource-shaped');
  });

  it('agent: → agentRegistry.register 子 Agent 定义，记录生效', async () => {
    manifestWith('agent:helper', writeUserModule('agent.js', `
      export default { name: 'helper', description: 'd', systemPrompt: 's', allowedTools: [], maxTurns: 3 };
    `));
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const register = vi.fn();
    await applyAgentReplacements({ cwd: tmpDir, extensionRegistry, agentRegistry: { register } as never });

    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'helper', maxTurns: 3 }));
    expect(extensionRegistry.get('agent:helper')?.effective).toBe(true);
  });

  it('router: → profiles.registerRouter 同名覆盖出厂路由，可 switchRouter 命中', async () => {
    const ROUTER_NAME = `ext-router-${Date.now()}`;
    manifestWith('router:normal', writeUserModule('router.js', `
      export default { name: ${JSON.stringify(ROUTER_NAME)}, toolAllowlist: [], toolBlacklist: [], skipSections: [], skipRuntimeSources: [], sourceOverrides: {} };
    `));
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    await applyRouterReplacements({ cwd: tmpDir, extensionRegistry });

    expect(extensionRegistry.get('router:normal')?.effective).toBe(true);
    switchRouter(ROUTER_NAME);
    expect(getActiveRouterName()).toBe(ROUTER_NAME);
  });

  it('slot: → pipeline.registerStageModule 同名替换，记录生效 + replacedFrom 出厂 impl', async () => {
    manifestWith('slot:context', writeUserModule('stage.js', `
      export default { id: 'builtin:layered-composer', reads: ['history'], writes: ['messages'], run: async (s) => s };
    `));
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const registerStageModule = vi.fn(() => ({ dispose() {} }));
    await applySlotReplacements({ cwd: tmpDir, extensionRegistry, pipeline: { registerStageModule } as never });

    expect(registerStageModule).toHaveBeenCalledWith(expect.objectContaining({ id: 'builtin:layered-composer' }));
    const entry = extensionRegistry.get('slot:context');
    expect(entry?.effective).toBe(true);
    expect(entry?.replacedFrom).toBe('builtin:layered-composer');
  });

  it('service: → setService 键从 point 派生（service:compressor → compressor）', async () => {
    manifestWith('service:compressor', writeUserModule('svc.js', `
      export default { compress: async () => ({ ok: true }) };
    `));
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const setService = vi.fn();
    await applyServiceReplacements({ cwd: tmpDir, extensionRegistry, setService });

    expect(setService).toHaveBeenCalledWith('compressor', expect.objectContaining({ compress: expect.any(Function) }));
    expect(extensionRegistry.get('service:compressor')?.effective).toBe(true);
  });

  it('service: 导出 null → effective=false，不调 setService', async () => {
    manifestWith('service:compressor', writeUserModule('bad-svc.js', 'export default null;\n'));
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    const setService = vi.fn();
    await applyServiceReplacements({ cwd: tmpDir, extensionRegistry, setService });

    expect(setService).not.toHaveBeenCalled();
    expect(extensionRegistry.get('service:compressor')?.effective).toBe(false);
  });

  it('模块路径不存在 → effective=false + error（不炸装配）', async () => {
    manifestWith('slot:context', './modules/nope.js');
    const { extensionRegistry } = createArchRegistries({ cwd: tmpDir });
    await applySlotReplacements({ cwd: tmpDir, extensionRegistry, pipeline: { registerStageModule: vi.fn() } as never });
    expect(extensionRegistry.get('slot:context')?.effective).toBe(false);
    expect(extensionRegistry.get('slot:context')?.error).toBeTruthy();
  });
});
