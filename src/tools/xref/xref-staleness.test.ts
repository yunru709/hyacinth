/**
 * xref-staleness.test.ts — 「索引知道自己旧不旧」的回归点（2026-09-19）
 *
 * 背景：`xref` 的索引是**派生数据**，而代码一直在变。原先 `isReady()` 只回答"建过没有"，
 * 不回答"建完之后文件改过没有"（虽然 `meta.built_at` 与 `files.mtime_ms` 都存着，只是没拿来比）。
 * 于是查询会给出**看起来完整、其实可能不全**的答案。本文件锁住的行为分三类：
 *   ① 新鲜 → 不带提示（第 1 例兼作隔离自检）；
 *   ④ 小改动（≤20 文件）→ 查询前**自动同步**（Phase 4），结果里写明同步了几个，
 *      且数据确实已刷新（用"新符号查得到"当硬判据，而不是只看多了一行提示）；
 *   ⑤ 变更超阈值（>20）→ **不隐式重建**，只如实告知陈旧并给下一步（xref_build）。
 *
 * 演进记录：原先还有一条「③ 改了 1 个文件 → 查询带出陈旧提示、且不得顺手重建」——
 * Phase 4 **有意反转**了它（小改动就该自动保鲜）。这是期望变更、不是"让测试变绿"；
 * 它的两条断言分别由 ④（新行为）与 ⑤（超阈值时仍保持原意）承接，故删除。
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


  it('④ 小改动（≤20 文件）→ 查询前自动同步，且结果里写明同步了几个（Phase 4）', async () => {
    const root = await makeProject({ 'src/a.ts': A_TS, 'src/b.ts': B_TS });
    const m = new XrefManager();
    await m.init(root);
    try {
      await m.build(undefined, undefined, 50, { force: true });

      // 只改 1 个文件（在阈值内）→ 应触发自保鲜
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(
        path.join(root, 'src', 'b.ts'),
        [
          'export function helperA(): number {',
          '  return 1;',
          '}',
          '',
          'export function helperNew(): number {',
          '  return 9;',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const out = await new XrefQueryTool(m).execute({ action: 'defs', symbol: 'helperNew' });
      expect(out).toContain('已自动同步'); // ① 明示：同步了（不是静默重建）
      expect(out).toContain('src/b.ts'); // ② 硬判据：新符号真的查得到 = 数据确实已刷新
      expect(out).not.toContain('索引可能陈旧'); // ③ 同步后不该再报陈旧
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('⑤ 变更超阈值（>20 文件）→ 不隐式重建，只如实告知并给下一步', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      files[`src/f${i}.ts`] = `export function fn${i}(): number {\n  return ${i};\n}\n`;
    }
    const root = await makeProject(files);
    const m = new XrefManager();
    await m.init(root);
    try {
      await m.build(undefined, undefined, 50, { force: true });

      // 25 个文件全改（超阈值 20）→ 不该内联重建
      await new Promise((r) => setTimeout(r, 20));
      for (let i = 0; i < 25; i++) {
        await fs.writeFile(
          path.join(root, 'src', `f${i}.ts`),
          `export function fn${i}(): number {\n  return ${i + 100};\n}\n`,
          'utf-8',
        );
      }

      const out = await new XrefQueryTool(m).execute({ action: 'defs', symbol: 'fn0' });
      expect(out).not.toContain('已自动同步'); // ① 不隐式重建
      expect(out).toContain('索引可能陈旧'); // ② 但如实告知
      expect(out).toContain('xref_build'); // ③ 并给下一步
    } finally {
      m.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
