/**
 * 工作区围栏测试 —— 写类工具限工作区、.git 拒写；读类/bash 不受限。
 *
 * ⚠️ 夹具纪律（2026-09-19 被 CI 教明白的）：
 *   围栏判界用的是 **真实路径**（`resolveRealPathSync`：目标不存在时向上找最近存在的父目录）。
 *   ⇒ 夹具必须用**真实存在**的目录，且"界外"要用另一个**真实目录**，**不能**用平台特有绝对路径
 *      （如 `C:/Windows/...`）或凭空写 `/tmp/xxx`：
 *       · `C:/Windows/...` 在 Linux 上被当成普通相对名 ⇒ 拼进 root 之内 ⇒ 断言"必须被拒"**红** ✗
 *       · 不存在的 `/tmp/fence-root` 在 Linux 上会被解析到 `/tmp` ⇒ `/tmp` 之下一切都算"界内" ✗
 *   正确样式见 `builtin-tool-contracts.test.ts` 的同名 describe（tmpRoot + path.join + 真 mkdir ✓）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  // 真实存在的根 + 真实存在的"界外"（两者同级、互不包含）
  let root: string;
  let outside: string;
  const made: string[] = [];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-outside-'));
    made.push(root, outside);
  });

  afterAll(() => {
    for (const d of made.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

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

  it('工作区外路径被拒绝（界外用另一个**真实目录** ⇒ 平台无关 ✓）', async () => {
    const registry = makeFakeRegistry([makeTool('write', 'W')]);
    applyWorkspaceFence(registry, root);
    const wrapped = registry.get('write')!;
    const result = await wrapped.execute({ file_path: path.join(outside, 'evil.txt') }, undefined);
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
    await expect(read.execute({ file_path: path.join(outside, 'file.txt') }, undefined)).resolves.toBe('R');
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
    let extra: string;
    let sibling: string;

    beforeAll(() => {
      extra = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-writable-'));
      sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-writable-sibling-'));
      made.push(extra, sibling);
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
      const other = await wrapped.execute({ file_path: path.join(outside, 'evil.txt') }, undefined);
      expect(other).toMatch(/outside the workspace root/);
      // 与额外根"同级"但不在其内的**真实目录**也必须拒（防"前缀相同即放行"这类实现错误）
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
