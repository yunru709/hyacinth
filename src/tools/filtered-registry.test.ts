/**
 * FilteredToolRegistry — 「本地优先」契约守卫测试。
 *
 * 背景（2026-10-08 实测事故）：子 Agent 用 view_media 看图，图像**永远注入不到自己**，
 * 反而泄漏进主 Agent 的上下文。根因是本 registry 的 get/getAll 只读 parentRegistry，
 * 子 loop 构造时注册的、绑定自身状态的同名工具被静默忽略 ⇒ get() 回落到父实例
 * （闭包捕获的是**父 loop** 的 pendingImageInjections）。
 *
 * 这几条断言锁死该契约：**凡 register 进本 registry 的实例，必须能被 get/getAll 看见，
 * 且同名时覆盖父实例。** 破坏它，子 Agent 隔离即静默失效。
 */
import { describe, it, expect } from 'vitest';
import { FilteredToolRegistry } from './filtered-registry.js';
import { ToolRegistry } from './registry.js';
import type { Tool } from './interface.js';

/** 造一个最小可辨识工具：description/tag 用来区分"哪个实例" */
function makeTool(name: string, tag: string): Tool {
  return {
    name,
    description: `${name} :: ${tag}`,
    inputSchema: { type: 'object', properties: {} },
    async execute() { return tag; },
  } as unknown as Tool;
}

describe('FilteredToolRegistry 本地优先契约', () => {
  it('本地注册的同名工具覆盖父实例（子 loop 自建实例必须胜出）', () => {
    const parent = new ToolRegistry();
    parent.register(makeTool('view_media', 'PARENT'));
    const filtered = new FilteredToolRegistry(parent, ['view_media']);

    // 未本地注册前：回落到父实例
    expect(filtered.get('view_media')!.description).toContain('PARENT');

    // 子 loop 构造时注册绑定自身状态的同名工具
    filtered.register(makeTool('view_media', 'CHILD'));

    expect(filtered.get('view_media')!.description).toContain('CHILD');
    expect(filtered.getAll().find((t) => t.name === 'view_media')!.description).toContain('CHILD');
  });

  it('execute 真的路由到本地实例（不止是元数据）', async () => {
    const parent = new ToolRegistry();
    parent.register(makeTool('view_media', 'PARENT'));
    const filtered = new FilteredToolRegistry(parent, ['view_media']);
    filtered.register(makeTool('view_media', 'CHILD'));

    const tool = filtered.get('view_media')!;
    await expect(tool.execute({})).resolves.toBe('CHILD');
  });

  it('白名单仍是唯一准入判据：本地注册但不在白名单 ⇒ 不可见', () => {
    const parent = new ToolRegistry();
    parent.register(makeTool('read', 'PARENT'));
    const filtered = new FilteredToolRegistry(parent, ['read']);

    filtered.register(makeTool('bash', 'LOCAL')); // 不在白名单

    expect(filtered.get('bash')).toBeUndefined();
    expect(filtered.has('bash')).toBe(false);
    expect(filtered.getAll().map((t) => t.name)).not.toContain('bash');
  });

  it('合并结果不产生重复名，且保留父的非同名工具', () => {
    const parent = new ToolRegistry();
    parent.register(makeTool('read', 'PARENT'));
    parent.register(makeTool('write', 'PARENT'));
    const filtered = new FilteredToolRegistry(parent, ['read', 'write']);
    filtered.register(makeTool('read', 'CHILD'));

    const names = filtered.getAll().map((t) => t.name);
    expect(names.filter((n) => n === 'read')).toHaveLength(1);
    expect(names).toContain('write');
  });

  it('空白名单 ⇒ 全量透传（含本地覆盖）', () => {
    const parent = new ToolRegistry();
    parent.register(makeTool('read', 'PARENT'));
    const filtered = new FilteredToolRegistry(parent, []);
    filtered.register(makeTool('read', 'CHILD'));

    expect(filtered.get('read')!.description).toContain('CHILD');
    expect(filtered.getAll()).toHaveLength(1);
  });

  it('回归：子 loop 注册的沙箱包装必须真的生效（同族静默失效）', () => {
    // 复刻 delegate-tool 的沙箱包装路径：遍历 getAll() → 包装 → register 回去
    const parent = new ToolRegistry();
    parent.register(makeTool('read', 'PARENT'));
    const filtered = new FilteredToolRegistry(parent, ['read']);

    for (const tool of filtered.getAll()) {
      filtered.register({ ...tool, description: `${tool.description} :: SANDBOXED` });
    }

    expect(filtered.get('read')!.description).toContain('SANDBOXED');
  });
});
