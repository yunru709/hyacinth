/**
 * xref-staleness.test.ts — 「索引知道自己旧不旧」的回归点（2026-09-19）
 *
 * 背景：`xref` 的索引是**派生数据**，而代码一直在变。原先 `isReady()` 只回答"建过没有"，
 * 不回答"建完之后文件改过没有"（虽然 `meta.built_at` 与 `files.mtime_ms` 都存着，只是没拿来比）。
 * 于是查询会给出**看起来完整、其实可能不全**的答案。本文件锁住新行为：
 *   ① 新鲜 → 不带提示；② 有文件变更 → **带提示且给出下一步（xref_build）**，但不拒绝回答。
 *
 * 隔离（照抄同目录 xref-tools.test.ts 的约定）：`XrefManager.init()` 把库固定在
 * `~/.agent/cache/xref-<projectKey>.sqlite`，全仓**没有**环境变量开关，故
 * **劫持 `os.homedir()`** 到临时目录。这正是今晚 `model-channels.json` 事故的教训：
 * 测试必须证明自己的产物落在了临时目录里（见断言 ①）。
 *
 * 注意：实现里自检结果按 dbPath **缓存 5 秒**（避免查询密集时重复 stat 上千文件），
 * 故每个用例用**各自独立的临时项目**（dbPath 不同 → 不撞缓存）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from './manager.js';
import { XrefQueryTool } from './xref-query.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-stale-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

const A_TS = [
  "import { helperA } from './b';",
  '',
  'export function main(): number {',
  '  return helperA();',
  '}',
  '',
].join('\n');
const B_TS = ['export function helperA(): number {', '  return 1;', '}', ''].join('\n');

describe('xref 索引陈旧自检', () => {
  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-stale-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome); // 劫持必须还原，否则污染后续用例
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('① 隔离自检：索引库必须落在临时 home 内（绝不写真实 ~/.agent/cache）', async () => {
    const root = await makeProject({ 'src/a.ts': A_TS, 'src/b.ts': B_TS });
    const m = new XrefManager();
    await m.init(root);
    try {
      const cacheDir = path.join(fakeHome, '.agent', 'cache');
      const files = await fs.readdir(cacheDir);
      expect(files.some((f) => f.startsWith('xref-') && f.endsWith('.sqlite'))).toBe(true);
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('② 索引新鲜时：查询结果**不带**陈旧提示', async () => {
    const root = await makeProject({ 'src/a.ts': A_TS, 'src/b.ts': B_TS });
    const m = new XrefManager();
    await m.init(root);
    try {
      await m.build(undefined, undefined, 50, { force: true });
      const out = await new XrefQueryTool(m).execute({ action: 'deps', file: 'src/a.ts' });
      expect(out).toContain('src/b.ts');        // 查询本身正常工作
      expect(out).not.toContain('索引可能陈旧');
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('③ 改了文件之后：查询**带出陈旧提示**，并给出下一步（不拒绝、不隐式重建）', async () => {
    const root = await makeProject({ 'src/a.ts': A_TS, 'src/b.ts': B_TS });
    const m = new XrefManager();
    await m.init(root);
    try {
      await m.build(undefined, undefined, 50, { force: true });

      // 改动 b.ts：内容与 mtime 都要变（1ms 容差来自实现里的比对口径）
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(
        path.join(root, 'src', 'b.ts'),
        ['export function helperA(): number {', '  return 2;', '}', ''].join('\n'),
        'utf-8',
      );

      const out = await new XrefQueryTool(m).execute({ action: 'deps', file: 'src/a.ts' });
      expect(out).toContain('索引可能陈旧');    // ① 陈旧要说得出来
      expect(out).toContain('xref_build');      // ② 要给下一步
      expect(out).toContain('src/b.ts');        // ③ 但不拒绝回答（照给结果）

      // ④ 不得"顺手重建"：索引里仍是旧内容（未重新解析）
      const defs = await new XrefQueryTool(m).execute({ action: 'defs', symbol: 'helperA' });
      expect(defs).toContain('src/b.ts');
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
