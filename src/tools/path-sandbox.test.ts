/**
 * 工作区围栏测试 —— 写类工具限工作区、.git 拒写；读类/bash 不受限。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { Tool } from './interface.js';
import { applyWorkspaceFence } from './path-sandbox.js';

function makeTool(name: string, tag: string): Tool {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object' },
    execute: async () => tag,
  } as Tool;
}

/** 捕获 register 调用的假注册表（与 GenericRegistry 的最小面一致） */
function makeFakeRegistry(initial: Tool[]) {
  const items = new Map<string, Tool>();
  for (const t of initial) items.set(t.name, t);
  return {
    getAll: () => [...items.values()],
    register: (tool: Tool) => { items.set(tool.name, tool); },
    get: (name: string) => items.get(name),
  };
}

describe('applyWorkspaceFence（主 Agent 工作区围栏）', () => {
  const root = path.resolve('/tmp/fence-root');

  it('write/edit/multi_edit/insert 被包装；read/grep/glob/bash 不受影响', () => {
    const registry = makeFakeRegistry([
      makeTool('write', 'W'), makeTool('edit', 'E'), makeTool('multi_edit', 'M'), makeTool('insert', 'I'),
      makeTool('read', 'R'), makeTool('grep', 'G'), makeTool('bash', 'B'),
    ]);
    const n = applyWorkspaceFence(registry, root);
    expect(n).toBe(4);
  });

  it('工作区内路径正常透传', async () => {
    const registry = makeFakeRegistry([makeTool('write', 'W')]);
    applyWorkspaceFence(registry, root);
    const wrapped = registry.get('write')!;
    await expect(wrapped.execute({ file_path: 'src/a.ts' }, undefined)).resolves.toBe('W');
  });

  it('工作区外路径被拒绝', async () => {
    const registry = makeFakeRegistry([makeTool('write', 'W')]);
    applyWorkspaceFence(registry, root);
    const wrapped = registry.get('write')!;
    const result = await wrapped.execute({ file_path: 'C:/Windows/system32/evil.txt' }, undefined);
    expect(result).toMatch(/outside the workspace root/);
  });

  it('.git 目录拒写（含嵌套 .git/hooks）', async () => {
    const registry = makeFakeRegistry([makeTool('edit', 'E')]);
    applyWorkspaceFence(registry, root);
    const wrapped = registry.get('edit')!;
    const hook = await wrapped.execute({ file_path: '.git/hooks/pre-commit' }, undefined);
    expect(hook).toMatch(/\.git.*blocked/);
    const nested = await wrapped.execute({ file_path: path.join(root, 'sub', '.git', 'config') }, undefined);
    expect(nested).toMatch(/\.git.*blocked/);
  });

  it('read 不受围栏限制（读外部是合法需求）', async () => {
    const registry = makeFakeRegistry([makeTool('read', 'R')]);
    applyWorkspaceFence(registry, root);
    const read = registry.get('read')!;
    await expect(read.execute({ file_path: 'C:/anywhere/file.txt' }, undefined)).resolves.toBe('R');
  });

  it('重复调用幂等（同源覆盖允许）', () => {
    const registry = makeFakeRegistry([makeTool('write', 'W')]);
    applyWorkspaceFence(registry, root);
    expect(() => applyWorkspaceFence(registry, root)).not.toThrow();
    expect(registry.get('write')).toBeDefined();
  });
});
