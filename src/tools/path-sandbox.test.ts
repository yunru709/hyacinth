/**
 * 工作区围栏测试 —— 写类工具限工作区、.git 拒写；读类/bash 不受限。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
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

  // ── 额外可写根（2026-09-19 用户裁定 (a)：放行 ~/.agent/prompts/persona/，让 edit 能写记事本）──
  // 这组用例是那条裁定的**边界守卫**：放行面只增不减，且**不**给出绕过 .git 的后门 ✓
  describe('额外可写根（extraWritableRoots）', () => {
    // ⚠️ 夹具必须是**真实存在**的目录：围栏用真实路径（跟随符号链接）判界，
    //    对不存在的路径会退到某个已存在的祖先 ⇒ 结果不可预期。
    //    首版我用 /tmp/extra-writable（不存在）⇒ 两条红、一条**因错误的原因而绿**（假绿 ✗）。
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-writable-'));
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-writable-sibling-'));
    afterAll(() => {
      try { fs.rmSync(extra, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(sibling, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('额外可写根**内**的路径放行', async () => {
      const registry = makeFakeRegistry([makeTool('edit', 'E')]);
      applyWorkspaceFence(registry, root, [extra]);
      const wrapped = registry.get('edit')!;
      const res = await wrapped.execute({ file_path: path.join(extra, 'scratchpad.md') }, undefined);
      expect(res, '额外根内应放行（记事本就走这条路）').toBe('E');
    });

    it('额外可写根**之外**的外部路径仍拒 —— 放行面没有被扩大', async () => {
      const registry = makeFakeRegistry([makeTool('edit', 'E')]);
      applyWorkspaceFence(registry, root, [extra]);
      const wrapped = registry.get('edit')!;
      const outside = await wrapped.execute({ file_path: 'C:/Windows/system32/evil.txt' }, undefined);
      expect(outside).toMatch(/outside the workspace root/);
      // 与额外根"同级"但不在其内的路径也必须拒（防"前缀相同即放行"这类实现错误）
      const sib = await wrapped.execute({ file_path: path.join(sibling, 'x') }, undefined);
      expect(sib, '与额外根同级、但不在其内的真实目录，仍必须拒').toMatch(/outside the workspace root/);
    });

    it('额外可写根里的 .git 仍拒 —— 不给绕过 .git 的后门', async () => {
      const registry = makeFakeRegistry([makeTool('edit', 'E')]);
      applyWorkspaceFence(registry, root, [extra]);
      const wrapped = registry.get('edit')!;
      const hook = await wrapped.execute({ file_path: path.join(extra, '.git', 'hooks', 'pre-commit') }, undefined);
      expect(hook).toMatch(/\.git.*blocked/);
    });

    it('不传额外根 ⇒ 与从前完全一致（默认严格）', async () => {
      const registry = makeFakeRegistry([makeTool('edit', 'E')]);
      applyWorkspaceFence(registry, root);
      const wrapped = registry.get('edit')!;
      const res = await wrapped.execute({ file_path: path.join(extra, 'scratchpad.md') }, undefined);
      expect(res, '不传额外根时，那个目录仍应被拒').toMatch(/outside the workspace root/);
    });
  });
});
