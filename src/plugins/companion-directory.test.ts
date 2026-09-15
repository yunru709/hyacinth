// ============================================================
// companion 目录插件（注册式）端到端验收测试
// ============================================================
// 验证「陪伴模式 + 世界引擎 = 自带插件，内核只供能力服务」的完整链路：
//   1. 统一宿主：目录插件 deps 内核插件（bypass）+ getService 取能力服务
//   2. 世界引擎：内核只注册 createAgent 工厂服务（轻量引用），世界引擎 agent
//      由 companion 插件经工厂创建/注册/激活 —— 不再作为内核插件被无条件 mount
//   3. 陪伴模式：getService('context.mode') 切 Router + activateForMode 激活
//   4. 注册式停用：deactivate → 世界引擎摘除 + 服务回滚 + 模式退出
//
// 使用真实插件文件（复制 plugins/companion 到临时项目），不内联重写。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoopHookBus } from '../orchestrator/loop-hooks.js';
import { PluginManager } from './manager.js';
import { createBypassPlugin } from './bypass-plugin.js';
import { createContextModeService } from '../gateway/context-mode-service.js';
import { WorldEngine } from '../world-engine/agent.js';
import { switchRouter, getActiveRouterName } from '../context/profiles.js';
import type { BypassManager } from '../bypass/manager.js';

// P-Config 收敛后插件统一走全局 ~/.agent/plugins/ + ~/.agent/plugins.config.json：
// mock homedir → 测试临时目录 tmp，tmp/.agent/ 即全局插件目录。
// homeBox 容器规避 vi.mock 提升期 TDZ。
const { mockHomedir, homeBox } = vi.hoisted(() => {
  const homeBox = { path: '' };
  return { homeBox, mockHomedir: vi.fn(() => homeBox.path) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, homedir: mockHomedir };
  return { ...mocked, default: mocked };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 复制仓库内置 companion 目录插件包到临时项目 */
function copyCompanionPlugin(projectDir: string): void {
  const src = path.resolve(__dirname, '../../plugins/companion');
  fs.cpSync(src, path.join(projectDir, '.agent', 'plugins', 'companion'), { recursive: true });
}

interface FakeSkillRegistry {
  getAll(): Array<{ name: string; description?: string }>;
  getFullDefinitions(names: string[]): string;
}

function makeManager(projectDir: string): PluginManager {
  return new PluginManager({
    toolRegistry: {} as never,
    skillRegistry: { getAll: () => [], getFullDefinitions: () => '' } as FakeSkillRegistry as never,
    contextComposer: {} as never,
    projectDir,
  });
}

/** 统一宿主：挂内核基座插件 + 注册内核能力服务（等价 agent-assembly 装配） */
function wireKernelHost(host: ReturnType<PluginManager['getHost']>, loop: { bypassManager?: BypassManager | null }) {
  const hostAny = host as unknown as {
    setHooks(b: unknown): void;
    mount(p: unknown): Promise<unknown>;
    register(k: string, v: unknown): unknown;
  };
  hostAny.setHooks(createLoopHookBus());
  void hostAny.mount(createBypassPlugin({
    modelRouter: {} as never,
    memoryFilePath: '/tmp/memory.md',
    loop,
  }));
  // 内核能力服务（轻量引用）：世界引擎工厂 + 模式切换 —— 不 mount 任何世界引擎插件
  hostAny.register('world-engine.createAgent', (name: string) => new WorldEngine(name));
  hostAny.register('context.mode', createContextModeService());
}

describe('companion 目录插件（自带插件 · 内核只供能力服务）', () => {
  let tmp = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-dir-plugin-'));
    homeBox.path = tmp; // homedir → tmp：tmp/.agent/plugins 即全局插件目录
    copyCompanionPlugin(tmp);
  });

  afterEach(() => {
    try { switchRouter('normal'); } catch { /* 未注册忽略 */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('统一宿主：目录插件 deps bypass + 经工厂创建世界引擎（内核不 mount 世界引擎插件）', async () => {
    // 配置 companion 插件角色（无 ~/.agent/companion/.last-character 依赖）
    fs.writeFileSync(path.join(tmp, '.agent', 'plugins.config.json'), JSON.stringify({
      plugins: { companion: { enabled: true, config: { characterName: '柔柔' } } },
    }));

    const mgr = makeManager(tmp);
    const host = mgr.getHost();
    const loop = { bypassManager: undefined as BypassManager | undefined };
    wireKernelHost(host, loop);

    mgr.setHooks(host as never);
    await mgr.loadAll();

    const plugin = mgr.get('companion');
    expect(plugin?.status).toBe('activated');

    // 世界引擎：companion 插件经 createAgent 工厂创建并注册（内核无独立 agent 服务）
    const agent = loop.bypassManager?.getAgent('world-engine');
    expect(agent).toBeTruthy();
    // 插件注册的实例服务（router / UI 取用）
    expect(host.get('world-engine.agent')).toBeTruthy();

    // 陪伴模式已激活：Router 切换 + bypass 模式活跃
    const mode = host.get('context.mode') as { isCompanionActive(): boolean };
    expect(getActiveRouterName()).toBe('companion');
    expect(mode.isCompanionActive()).toBe(true);
    expect(loop.bypassManager?.isActive('world-engine')).toBe(true);

    // ── 注册式停用：卸载 → 世界引擎摘除 + 服务回滚 + 模式退出 ──
    await mgr.deactivate('companion');
    expect(loop.bypassManager?.getAgent('world-engine')).toBeUndefined();
    expect(host.get('world-engine.agent')).toBeUndefined(); // ctx.register 自动回滚
    expect(mode.isCompanionActive()).toBe(false);
    expect(loop.bypassManager?.isActive('world-engine')).toBe(false);

    await host.dispose();
  });

  it('无角色：只切陪伴模式，不创建世界引擎（能力服务空转，无 agent 无实例服务）', async () => {
    // 显式配置空角色（禁用世界引擎），隔离全局 ~/.agent/companion/.last-character 污染
    fs.writeFileSync(path.join(tmp, '.agent', 'plugins.config.json'), JSON.stringify({
      plugins: { companion: { enabled: true, config: { characterName: '' } } },
    }));

    const mgr = makeManager(tmp);
    const host = mgr.getHost();
    const loop = { bypassManager: undefined as BypassManager | undefined };
    wireKernelHost(host, loop);

    mgr.setHooks(host as never);
    await mgr.loadAll();

    expect(mgr.get('companion')?.status).toBe('activated');
    expect(loop.bypassManager?.getAgent('world-engine')).toBeUndefined();
    expect(host.get('world-engine.agent')).toBeUndefined();
    // 模式仍激活（陪伴会话可无世界引擎运行）
    expect(getActiveRouterName()).toBe('companion');

    await mgr.deactivate('companion');
    expect(getActiveRouterName()).toBe('normal');

    await host.dispose();
  });
});
