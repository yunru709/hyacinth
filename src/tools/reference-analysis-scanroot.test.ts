/**
 * reference-analysis-scanroot.test.ts — 不变量：**引用扫描不得越过"文件所在项目"**
 *
 * 背景（2026-09-19 修复）：
 *   原 `findProjectRoot` 会一路向上走到**用户目录** ✗ —— 因为 PROJECT_MARKERS 含 package.json，
 *   而 `C:\Users\<name>\package.json` 常常存在（某次 npm init 的残留即可）。
 *   ⇒ 扫描根落到用户目录 ⇒ 500 文件上限被系统目录吃光 ⇒ **连自己项目里的引用都扫不到**
 *     （实测：产出直接为空串 —— 不是"没有引用"，是"什么都没分析到"）。
 *
 * 修后规则：
 *   · 向上走但**不许越过 home 与盘根**；边界本身不作为项目根 ✓
 *   · 边界内找不到标记 ⇒ 退回**文件所在目录** ✓
 *   · 若文件所在目录本身就在边界上（= 等于"扫描整个用户目录"）⇒ 返回 null ⇒ **不扫描** ✓
 *   · 主用例不受影响：仓库内改文件时 `.git` 在 home 之下，第一轮即命中 ✓
 *
 * ⚠️ 第三条用例（对照）**必须留着**：它是这个文件的观测点有效性的证据 ✓ ——
 *    没有它，"无 .git 时也没报错"可能只是**产出为空导致的空过**（我第一版复现就栽在这里 ✗）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeReferences } from './reference-analysis.js';

const created: string[] = [];

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

/** 临时"项目"：src/a.ts 定义 targetFn，src/caller.ts 引用它；withGit 决定是否放 .git 标记 */
function makeProject(withGit: boolean): { root: string; target: string } {
  const root = tmpDir(withGit ? 'scanroot-git-' : 'scanroot-nogit-');
  if (withGit) fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'caller.ts'),
    "import { targetFn } from './a.js';\n\nexport const v = targetFn();\n",
    'utf8',
  );
  return { root, target: path.join(root, 'src', 'a.ts') };
}

/** 走"无能力"那条路（capability=null ⇒ 核心兜底扫描）—— 扫描根逻辑就在这条路上 */
async function run(target: string): Promise<string> {
  const content = 'export function targetFn(): number {\n  return 1;\n}\n';
  return analyzeReferences(null, {
    toolName: 'write',
    filePath: target,
    before: '',
    after: content,
    args: { file_path: target },
  });
}

afterAll(() => {
  for (const d of created.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('引用扫描的项目根', () => {
  it('① 【对照】有 .git：项目内的 caller.ts 必须被找到（证明观测点有效）', async () => {
    const { target } = makeProject(true);
    expect(await run(target)).toContain('caller.ts');
  });

  it('② 无 .git：项目内的 caller.ts **也**应当被找到（不许把扫描面扩到用户目录）', async () => {
    const { target } = makeProject(false);
    expect(
      await run(target),
      '没有 .git 时扫描面跑到了上层（用户目录），500 文件上限被吃光 ⇒ 自己项目的引用也看不到',
    ).toContain('caller.ts');
  });

  it('③ 产出要么为空、要么只提项目内文件；**不得**出现项目外路径', async () => {
    const { root, target } = makeProject(false);
    const text = await run(target);
    expect(text.trim(), '产出为空 = 什么都没分析到，同样是失败').not.toBe('');
    expect(text).not.toMatch(/AppData/i);
    expect(text).not.toMatch(/\\Users\\/i);
    const esc = root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    expect(text, '只应提及项目内的相对路径').not.toMatch(new RegExp(esc));
  });
});
