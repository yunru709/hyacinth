/**
 * xref-parser-column.test.ts — 「库里每行数据出自哪个解析器」必须可查
 *
 * 为什么需要：解析器是一条**精度链**（ts-ast ＞ tree-sitter ＞ 正则），缺依赖会**静默降级**
 * （`ts-parser.ts` 是 `await import('typescript')`，装不上就回退正则）。若库里不记出处，
 * 「AST 级数据」与「正则级数据」就**不可区分** —— 消费侧无从判断哪些结果可放心行动。
 * 本文件锁住三件事：出处写对、占位行不混入、sync 构建下分布仍取自库内。
 *
 * 隔离：沿用同目录 xref-tools.test.ts 的约定（`init()` 把库固定在
 * `~/.agent/cache/xref-<key>.sqlite`，且全仓无环境变量开关）→ 劫持 `os.homedir()` 到临时目录，
 * 并在 afterAll 断言劫持已还原。绝不让测试写真实 ~/.agent/cache。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from './manager.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-parser-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

const PROJECT = {
  'src/a.ts': 'export function f1(): number {\n  return 1;\n}\n',
  'src/b.py': 'def f2():\n    return 2\n',
  'src/c.go': 'package main\n\nfunc f3() int {\n\treturn 3\n}\n',
};

describe('xref files.parser 出处列', () => {
  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-parser-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome); // 劫持必须还原，否则污染后续用例
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  // 出处会随精度链升级而迁移：.py 起初是 py-regex，Phase 2 引入语法树后变成 py-tree-sitter。
  // 这类"期望随设计前进"的改动必须显式改断言并写明迁移原因，而不是让测试去迁就实现。
  it('三种语言各记各的出处：.ts → ts-ast、.py → py-tree-sitter、.go → go-tree-sitter', async () => {
    const root = await makeProject(PROJECT);
    const m = new XrefManager();
    await m.init(root);
    try {
      const stats = await m.build(undefined, undefined, 50, { force: true });
      const pb = stats.parser_breakdown ?? {};
      expect(pb['ts-ast']).toBe(1);
      expect(pb['py-tree-sitter']).toBe(1); // Phase 2：语义链首选（py-regex 降为兜底）
      expect(pb['py-regex']).toBeUndefined(); // 没降级 → 兜底那级不该出现在库里
      expect(pb['go-tree-sitter']).toBe(1); // Go 已随铺量升级到语义链首选
      expect(pb['generic-regex']).toBeUndefined(); // 没降级 → 兜底那级不该出现在库里
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('分布里不出现空键（占位行 parser 为 NULL，必须被过滤掉）', async () => {
    const root = await makeProject(PROJECT);
    const m = new XrefManager();
    await m.init(root);
    try {
      const stats = await m.build(undefined, undefined, 50, { force: true });
      const pb = stats.parser_breakdown ?? {};
      // 断言的是"不存在无效键"，故本用例不依赖占位行是否真的被建出来（稳健）
      for (const k of Object.keys(pb)) {
        expect(k).toBeTruthy();
        expect(k).not.toBe('null');
      }
      expect(Object.values(pb).every((v) => v > 0)).toBe(true);
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('sync 构建（无变更、什么都没解析）下，分布仍取自库内而非本次解析数', async () => {
    // 这是刻意的设计选择：所有统计"一律取自库内实际行"，否则"全部未变"的那次构建
    // 会报 0，看起来像把索引清空了。此用例就是防这条回归。
    const root = await makeProject(PROJECT);
    const m = new XrefManager();
    await m.init(root);
    try {
      const first = await m.build(undefined, undefined, 50, { force: true });
      const again = await m.build(undefined, undefined, 50); // 默认 sync
      expect(again.parsed_files).toBe(0);          // 确认这次真的什么都没解析
      expect(again.parser_breakdown?.['ts-ast']).toBe(first.parser_breakdown?.['ts-ast']);
      // 同上：.py 的出处已随 Phase 2 迁移到语义链首选（py-regex 降为兜底、未参与）
      expect(again.parser_breakdown?.['py-tree-sitter']).toBe(1);
      expect(again.parser_breakdown?.['py-regex']).toBeUndefined();
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
