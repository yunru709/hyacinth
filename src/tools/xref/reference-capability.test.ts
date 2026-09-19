/**
 * reference-capability.test.ts — Phase 6 第 2 步：xref 侧「引用分析能力」的守卫
 *
 * 判据（对着行为，不看文档）：
 *  ① 索引新鲜 → 返回**精确调用方**（file:line + caller_name + [precise] 标注）
 *  ② 索引陈旧（变更数超自动同步阈值）→ 返回**空串**（消费侧契约：空 → 走兜底，不给假阴性）
 *  ③ 能力自身的运行态（arch links 用）如实记录：调用次数 / 退兜底次数 / 原因
 *
 * ⚠️ 夹具契约（首版踩过）：本用例走的是**改函数体内的行**这条真实路径 ——
 * 核心的符号判定是"先看变更片段里有没有声明；没有则回溯**包住这段文本的声明**"。
 * 所以 oldText 必须是**声明内部**的片段（如 `const x = 1;`），而不是裸符号名 ——
 * 裸符号名出现在它自己的声明行上时，往前找不到"外层声明"，判定必然为空。
 * （首版就是这么错的，靠能力运行态里的 lastReason='未能判定变更符号' 一眼定位。）
 *
 * 隔离：劫持 os.homedir()（xref 的库固定落 ~/.agent/cache）。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from './manager.js';
import { createReferenceAnalysisCapability } from './reference-capability.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;
const created: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'refcap-'));
  created.push(root);
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

/** 被编辑的文件：被别的文件调用的函数，函数体内含一行可改的语句 */
const EDITED = ['export function useIt(): number {', '  const x = 1;', '  return x;', '}', ''].join('\n');
/** 调用方文件：在**函数内**调用 useIt ⇒ 调用者名字可断言（模块级调用没有 caller_name） */
const CALLER = [
  "import { useIt } from './a.js';",
  '',
  'export function callerFn(): number {',
  '  return useIt();',
  '}',
  '',
].join('\n');

beforeAll(async () => {
  realHome = os.homedir();
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'refcap-home-'));
  created.push(fakeHome);
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterAll(async () => {
  homedirSpy.mockRestore();
  expect(os.homedir()).toBe(realHome);
  for (const d of created.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('createReferenceAnalysisCapability', () => {
  it('① 索引新鲜 → 精确调用方清单（含 file:line、caller_name、[precise] 标注）', async () => {
    const root = await makeProject({ 'src/a.ts': EDITED, 'src/b.ts': CALLER });
    const m = new XrefManager();
    await m.init(root);
    try {
      await m.build(undefined, undefined, 50, { force: true });
      const cap = createReferenceAnalysisCapability(m);

      const out = await cap.analyze({
        toolName: 'edit',
        filePath: path.join(root, 'src', 'a.ts'),
        before: EDITED,
        after: EDITED.replace('const x = 1;', 'const x = 2;'),
        oldText: 'const x = 1;',
        newText: 'const x = 2;',
      });

      if (!out) console.error('能力退兜底，运行态：', cap.getRuntime());
      expect(out).toContain('[References]');
      expect(out).toMatch(/b\.ts:\d+/); // file:line
      expect(out).toContain('(in callerFn)'); // caller_name（b.ts 里那次调用在 callerFn 内）
      expect(out).toContain('[precise]'); // 标注（消费 files.parser 列）
      expect(out).not.toContain('[heuristic]');

      const rt = cap.getRuntime();
      expect(rt.calls).toBe(1);
      expect(rt.fallbacks).toBe(0);
      expect(rt.lastReason).toBe('');
      expect(rt.lastSymbols).toContain('useIt'); // 回溯到包住这行的声明
    } finally {
      m.close();
    }
  });

  it('② 索引陈旧（变更数超阈值）→ 返回空串（让消费侧退兜底，不给假阴性）', async () => {
    // 25 个文件 > Phase 4 的自动同步上限 20 ⇒ ensureFresh 不重建 ⇒ 能力必须返回空
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`src/f${i}.ts`] = `export function fn${i}(): number {\n  return ${i};\n}\n`;
    const root = await makeProject(files);
    const m = new XrefManager();
    await m.init(root);
    try {
      await m.build(undefined, undefined, 50, { force: true });

      await new Promise((r) => setTimeout(r, 20));
      for (let i = 0; i < 25; i++) {
        await fs.writeFile(path.join(root, 'src', `f${i}.ts`), `export function fn${i}(): number {\n  return ${i + 100};\n}\n`, 'utf-8');
      }
      await new Promise((r) => setTimeout(r, 5));

      const cap = createReferenceAnalysisCapability(m);
      const out = await cap.analyze({
        toolName: 'edit',
        filePath: path.join(root, 'src', 'f0.ts'),
        before: 'export function fn0(): number {\n  return 0;\n}\n',
        after: 'export function fn0(): number {\n  return 100;\n}\n',
        oldText: 'return 0;',
        newText: 'return 100;',
      });

      expect(out).toBe('');
      const rt = cap.getRuntime();
      expect(rt.fallbacks).toBeGreaterThan(0);
      expect(rt.lastReason).toBe('索引陈旧'); // 原因是"陈旧"，不是别的
    } finally {
      m.close();
    }
  });

  it('③ 未初始化 → 空串且计入退兜底（不抛错，原因如实记录）', async () => {
    const m = new XrefManager(); // 未 init
    const cap = createReferenceAnalysisCapability(m);
    const out = await cap.analyze({
      toolName: 'write',
      filePath: '/nope/a.ts',
      before: '',
      after: 'x',
      oldText: '',
      newText: 'x',
    });
    expect(out).toBe('');
    const rt = cap.getRuntime();
    expect(rt.fallbacks).toBe(1);
    expect(rt.lastReason).toBe('索引未就绪');
  });
});
