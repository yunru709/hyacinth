// ============================================================
// ToolBundleRegistry 测试
// ============================================================
// 重点守卫两个回归点：
//  1. 内置包「移出工具」必须能持久化 —— load() 每次都会把内置工具列表
//     并回来，只从 tools 里删会在重启后被回填（removedTools 就是为此存在）
//  2. load() 不得把模块级常量直接挂进 config，否则增删工具会污染
//     进程内其他实例读到的默认值
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolBundleRegistry, BUILTIN_BUNDLE_NAMES } from './bundle-registry.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-reg-'));
  configPath = path.join(tmpDir, 'tool-bundles.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ToolBundleRegistry', () => {
  it('首次使用写入完整默认配置（含全部内置包，而非只有 all）', () => {
    const reg = new ToolBundleRegistry(tmpDir, configPath);
    const names = reg.list().map((b) => b.name).sort();
    expect(names).toEqual([...BUILTIN_BUNDLE_NAMES].sort());
  });

  it('内置包移出工具后重启仍生效（removedTools 对抗 builtin 回填）', () => {
    const reg = new ToolBundleRegistry(tmpDir, configPath);
    expect(reg.get('coding')?.tools).toContain('git');

    reg.removeTools('coding', ['git']);
    expect(reg.get('coding')?.tools).not.toContain('git');

    // 模拟重启：新实例从磁盘重新 load
    const rebooted = new ToolBundleRegistry(tmpDir, configPath);
    expect(rebooted.get('coding')?.tools).toContain('xref_build'); // 其余内置工具还在
    expect(rebooted.get('coding')?.tools).not.toContain('git');    // 移出的没被回填
    expect(rebooted.get('coding')?.removedTools).toContain('git');
  });

  it('重新加回工具会撤销 removedTools 记录', () => {
    const reg = new ToolBundleRegistry(tmpDir, configPath);
    reg.removeTools('coding', ['git']);
    reg.addTools('coding', ['git']);

    const rebooted = new ToolBundleRegistry(tmpDir, configPath);
    expect(rebooted.get('coding')?.tools).toContain('git');
    expect(rebooted.get('coding')?.removedTools ?? []).not.toContain('git');
  });

  it('自定义包移出工具不需要 removedTools，直接改 tools 即可', () => {
    const reg = new ToolBundleRegistry(tmpDir, configPath);
    reg.create('mine', '我的包', ['read', 'bash']);
    reg.removeTools('mine', ['bash']);

    const rebooted = new ToolBundleRegistry(tmpDir, configPath);
    expect(rebooted.get('mine')?.tools).toEqual(['read']);
    expect(rebooted.get('mine')?.removedTools).toBeUndefined();
  });

  it('对某个实例增删工具，不污染其他实例读到的内置默认值', () => {
    // 关键：两个实例都必须走「从磁盘 load」路径，否则测不到常量被就地修改的问题
    new ToolBundleRegistry(tmpDir, configPath); // 先落盘一份完整默认配置
    const a = new ToolBundleRegistry(tmpDir, configPath);
    const b = new ToolBundleRegistry(tmpDir, configPath);

    // A 上把 git 从 coding 移出
    a.removeTools('coding', ['git']);
    // B 是修改前就存在的实例，其内存里的 coding 不应受影响
    expect(b.get('coding')?.tools).toContain('git');

    // 再开一个全新实例，读到的是 A 落盘后的结果
    const c = new ToolBundleRegistry(tmpDir, configPath);
    expect(c.get('coding')?.tools).not.toContain('git');
  });

  it('内置包升级新增的工具会自动进包（保留 merge 语义）', () => {
    const reg = new ToolBundleRegistry(tmpDir, configPath);
    // 模拟旧版本磁盘数据：coding 少一个内置工具
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    raw.bundles.coding.tools = ['git'];
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf-8');

    const rebooted = new ToolBundleRegistry(tmpDir, configPath);
    expect(rebooted.get('coding')?.tools).toContain('git');
    expect(rebooted.get('coding')?.tools).toContain('xref_build'); // 新增的被并回来
  });

  it('内置包不可删除，自定义包可删除', () => {
    const reg = new ToolBundleRegistry(tmpDir, configPath);
    expect(() => reg.delete('coding')).toThrow(/builtin/);
    expect(() => reg.delete('common')).toThrow(/builtin|common/i);

    reg.create('temp', '临时', []);
    reg.activate(['temp']);
    reg.delete('temp');
    expect(reg.get('temp')).toBeUndefined();
    expect(reg.isAllMode()).toBe(true); // 删掉后激活集被清空 → 回到全量
  });
});
