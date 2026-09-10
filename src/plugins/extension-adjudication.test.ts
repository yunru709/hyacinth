import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginManager } from './manager.js';
import { ExtensionRegistry } from '../supervisor/extension-registry.js';

// =============================================================
// 名单裁决（扩展注册表方案阶段 4）：名单 > plugins.config > enabledByDefault
// =============================================================

const mockToolRegistry = {
  register: vi.fn(), unregister: vi.fn(), get: vi.fn(),
  getAll: vi.fn(() => []), getToolDefinitions: vi.fn(() => []), has: vi.fn(),
};
const mockSkillRegistry = {
  register: vi.fn(), unregister: vi.fn(), get: vi.fn(),
  getAll: vi.fn(() => []), getIndex: vi.fn(() => ''), getFullDefinitions: vi.fn(() => ''),
};
const mockContextComposer = { registerSource: vi.fn(), unregisterSource: vi.fn(), compose: vi.fn() };

/** 临时项目：.agent/plugins/adjud-plugin（enabledByDefault: true） */
function setupProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-adjud-'));
  const pluginDir = path.join(dir, '.agent', 'plugins', 'adjud-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    id: 'adjud-plugin', name: 'Adjud', description: 'd', entry: './index.js', enabledByDefault: true,
  }));
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    'export default { id: "adjud-plugin", name: "Adjud", description: "d", register() {} };\n',
  );
  return dir;
}

function createManager(projectDir: string, reg?: ExtensionRegistry): PluginManager {
  return new PluginManager({
    toolRegistry: mockToolRegistry as never,
    skillRegistry: mockSkillRegistry as never,
    contextComposer: mockContextComposer as never,
    projectDir,
    extensionRegistry: reg,
  });
}

describe('PluginManager 名单裁决', () => {
  it('名单 enabled=false 压制 enabledByDefault=true（不装载）', async () => {
    const reg = new ExtensionRegistry();
    reg.setManifest({ replacements: [], plugins: [{ id: 'adjud-plugin', enabled: false }], orders: [] });
    const mgr = createManager(setupProject(), reg);
    await mgr.loadAll();
    expect(mgr.get('adjud-plugin')).toBeUndefined();
  });

  it('名单 enabled=true 放行 plugins.config.json 的禁用（名单是决定性声明）', async () => {
    const dir = setupProject();
    fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agent', 'plugins.config.json'),
      JSON.stringify({ plugins: { 'adjud-plugin': { enabled: false, config: {} } } }),
    );
    const reg = new ExtensionRegistry();
    reg.setManifest({ replacements: [], plugins: [{ id: 'adjud-plugin', enabled: true }], orders: [] });
    const mgr = createManager(dir, reg);
    await mgr.loadAll();
    expect(mgr.get('adjud-plugin')).toBeDefined();
  });

  it('无名单声明时回退 plugins.config.json / enabledByDefault 语义', async () => {
    const mgr = createManager(setupProject());
    await mgr.loadAll();
    expect(mgr.get('adjud-plugin')).toBeDefined();
  });

  it('名单裁决面缺省（deps 未注入）不破坏原三源语义', async () => {
    const dir = setupProject();
    fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agent', 'plugins.config.json'),
      JSON.stringify({ plugins: { 'adjud-plugin': { enabled: false, config: {} } } }),
    );
    const mgr = createManager(dir);
    await mgr.loadAll();
    expect(mgr.get('adjud-plugin')).toBeUndefined();
  });
});
