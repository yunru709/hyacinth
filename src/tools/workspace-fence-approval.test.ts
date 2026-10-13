/**
 * 工作区围栏「越界 → 用户确认 → 放行」闭环的契约测试（2026-10-13 权限统一）。
 *
 * 为什么单独立一组用例：这次改造把「越界」从**硬拒**改成**可确认**，
 * 而安全改造最危险的失效形态是**静默放宽**（测试全绿但护栏没了）。
 * 所以这里显式钉住三条互斥的边界：
 *   ① 未批准 ⇒ 越界仍拒（安全下限不因改造丢失）
 *   ② 已批准 ⇒ 放行（新能力确实生效，不是"改了但没接上"）
 *   ③ `.git` ⇒ 无论批准与否恒拒（红线不可授权）
 * 判据本身（classifyWriteTarget）是围栏与权限层的**共同真源**，故一并钉住。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tool } from './interface.js';
import { applyWorkspaceFence, classifyWriteTarget } from './path-sandbox.js';

function makeTool(name: string, tag: string): Tool {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object' },
    execute: async () => tag,
  } as Tool;
}

function makeRegistry(initial: Tool[]) {
  const items = new Map<string, Tool>();
  for (const t of initial) items.set(t.name, t);
  return {
    getAll: () => [...items.values()],
    register: (tool: Tool) => { items.set(tool.name, tool); },
    get: (name: string) => items.get(name),
  };
}

describe('classifyWriteTarget（围栏 ∩ 权限层共用的判据）', () => {
  let root: string, extra: string, outside: string;
  const made: string[] = [];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-root-'));
    extra = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-extra-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-outside-'));
    made.push(root, extra, outside);
  });
  afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

  it('工作区内 → inside', () => {
    expect(classifyWriteTarget(root, [], path.join(root, 'a.txt'))).toBe('inside');
  });

  it('额外可写根内 → inside', () => {
    expect(classifyWriteTarget(root, [extra], path.join(extra, 'a.txt'))).toBe('inside');
  });

  it('两者之外 → outside', () => {
    expect(classifyWriteTarget(root, [extra], path.join(outside, 'a.txt'))).toBe('outside');
  });

  it('.git 内 → git（即便位于工作区内）', () => {
    expect(classifyWriteTarget(root, [], path.join(root, '.git', 'hooks', 'pre-commit'))).toBe('git');
  });

  it('与额外根同级、但不在其内 → 仍 outside（防「前缀相同即放行」）', () => {
    const sibling = path.join(path.dirname(extra), `${path.basename(extra)}-sib`);
    expect(classifyWriteTarget(root, [extra], path.join(sibling, 'a.txt'))).toBe('outside');
  });
});

describe('围栏 ∩ 已批准可写根（越界 = 可确认，而非不可能）', () => {
  let root: string, outside: string;
  const made: string[] = [];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-outside-'));
    made.push(root, outside);
  });
  afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

  it('① 未批准：越界仍被拒（安全下限不因改造丢失）', async () => {
    const approved = new Set<string>();
    const reg = makeRegistry([makeTool('write', 'W')]);
    applyWorkspaceFence(reg, root, [], approved);
    const res = await reg.get('write')!.execute({ file_path: path.join(outside, 'a.txt') }, undefined);
    expect(res).toMatch(/outside the workspace root/);
  });

  it('② 已批准该目录：围栏放行', async () => {
    const approved = new Set<string>([outside]);
    const reg = makeRegistry([makeTool('write', 'W')]);
    applyWorkspaceFence(reg, root, [], approved);
    const res = await reg.get('write')!.execute({ file_path: path.join(outside, 'a.txt') }, undefined);
    expect(res).toBe('W');
  });

  it('② 批准的是「可写根」而非单文件：其子目录一并放行', async () => {
    const approved = new Set<string>([outside]);
    const reg = makeRegistry([makeTool('edit', 'E')]);
    applyWorkspaceFence(reg, root, [], approved);
    const sub = path.join(outside, 'deep', 'er');
    fs.mkdirSync(sub, { recursive: true });
    const res = await reg.get('edit')!.execute({ file_path: path.join(sub, 'a.txt') }, undefined);
    expect(res).toBe('E');
  });

  it('③ .git 即便「已批准」也恒拒（红线不可授权）', async () => {
    const approved = new Set<string>([root]); // 连工作区根都批准了
    const reg = makeRegistry([makeTool('write', 'W')]);
    applyWorkspaceFence(reg, root, [], approved);
    const res = await reg.get('write')!.execute({ file_path: path.join(root, '.git', 'hooks', 'pre-commit') }, undefined);
    expect(res).toMatch(/\.git/);
  });

  it('不传已批准根 ⇒ 行为与改造前一致（向后兼容）', async () => {
    const reg = makeRegistry([makeTool('write', 'W')]);
    applyWorkspaceFence(reg, root, []);
    const res = await reg.get('write')!.execute({ file_path: path.join(outside, 'a.txt') }, undefined);
    expect(res).toMatch(/outside the workspace root/);
  });
});
