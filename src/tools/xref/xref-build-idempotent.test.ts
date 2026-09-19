/**
 * xref-build-idempotent.test.ts — 构建幂等守卫（2026-09-19 真实仓库冒烟发现的缺陷）
 *
 * 缺陷：同一库连跑多次 force 构建时行数成倍膨胀（实测 549→1098→1647 symbols；
 * 同一文件里同名符号出现 3 行；库 0.91→1.73→2.54 MB）。
 * 根因：重解析一个文件时不删它的旧子行（symbols/refs/imports），阶段二又插一遍。
 *
 * 为什么既有测试没抓到：它们每个用例都在**全新临时库**上跑 —— 一次插入不会产生累积。
 * 本文件补的正是这条：**在同一个库上重复构建，行数必须逐次相同**。
 * 这是"按需重建"能成立的前提：索引必须可被反复重建而不变形。
 *
 * 隔离：沿用同目录惯例（劫持 os.homedir()）。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from './manager.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

const PROJECT = {
  'src/a.ts': [
    "import { helperB } from './b';",
    '',
    'export function main(): number {',
    '  return helperB();',
    '}',
    '',
  ].join('\n'),
  'src/b.ts': 'export function helperB(): number {\n  return 1;\n}\n',
  'src/c.py': 'def gamma():\n    return 1\n',
  'src/d.go': 'package main\n\nfunc delta() int {\n\treturn 1\n}\n',
};

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-idem-'));
  for (const [rel, content] of Object.entries(PROJECT)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

describe('构建幂等：同一库上反复重建不得膨胀', () => {
  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-idem-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome);
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('三次 force 构建后行数完全一致（子行被正确替换而非累积）', async () => {
    const root = await makeProject();
    const m = new XrefManager();
    await m.init(root);
    try {
      const first = await m.build(undefined, undefined, 50, { force: true });
      const second = await m.build(undefined, undefined, 50, { force: true });
      const third = await m.build(undefined, undefined, 50, { force: true });

      expect(second.symbols).toBe(first.symbols);
      expect(second.refs).toBe(first.refs);
      expect(second.imports).toBe(first.imports);
      expect(third.symbols).toBe(first.symbols);
      expect(third.refs).toBe(first.refs);
      expect(third.imports).toBe(first.imports);

      // 三个文件各有符号 —— 保证上面的"相等"不是因为都是 0
      expect(first.symbols).toBeGreaterThanOrEqual(4);
      expect(first.refs).toBeGreaterThanOrEqual(2);
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('sync 构建（只重解析变更文件）同样不得让该文件的子行累积', async () => {
    const root = await makeProject();
    const m = new XrefManager();
    await m.init(root);
    try {
      const first = await m.build(undefined, undefined, 50, { force: true });

      // 改一个文件 → sync 构建只重解析它；不该让库里的行数变多
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(
        path.join(root, 'src', 'b.ts'),
        'export function helperB(): number {\n  return 2;\n}\n',
        'utf-8',
      );
      const second = await m.build(undefined, undefined, 50);

      expect(second.parsed_files).toBe(1); // 确认只重解析了 1 个
      expect(second.symbols).toBe(first.symbols); // 行数不变（旧子行被替换）
      expect(second.refs).toBe(first.refs);
      expect(second.imports).toBe(first.imports);
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
