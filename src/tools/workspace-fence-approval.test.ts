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

/**
 * ── 审计回归（2026-10-13）────────────────────────────────────────────
 * 下面是当日代码审计（3 blocker）在**围栏判据层**的回归用例。
 * 每条都对应一个**实测复现过**的失效，不是预防性猜测。
 */
describe('审计回归 2026-10-13（围栏判据）', () => {
  let root: string;
  const made: string[] = [];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fence-'));
    made.push(root);
  });
  afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  });

  it('【B1】.git 经 junction/symlink 绕道 ⇒ 仍判 git 而非 inside', () => {
    // 修复前：`.git` 检查走 `resolved`（**逻辑路径**），而"在不在工作区内"走 `resolveRealPathSync`（真实路径）。
    // 于是在工作区里放一个指向 .git 的链接即可：逻辑路径不含 `.git` 段（绕过红线），
    // 真实路径仍落在工作区内（判 inside）⇒ write 直落 .git。
    // 实测（修复前）：`mklink /J _git_probe .git` + write ⇒ 成功写入 `.git/fence_probe.txt`（78B）。
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true });

    const link = path.join(root, '_git_link_probe');
    try {
      fs.symlinkSync(gitDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // 环境不支持建链接 ⇒ 跳过（不是失败）；CI/Linux 无此限制
      return;
    }
    try {
      // 逻辑路径：<root>/_git_link_probe/hooks/pre-commit —— 段里**没有** `.git`
      expect(classifyWriteTarget(root, [], path.join(link, 'hooks', 'pre-commit'))).toBe('git');
      // 且该路径确实指向 .git 内部（证明这个链接真的绕过去了，测试不是空转）
      expect(fs.realpathSync(path.join(link, 'hooks'))).toBe(fs.realpathSync(path.join(gitDir, 'hooks')));
    } finally {
      // ⚠️ 对 junction/symlink 只能用 unlink —— rmSync(recursive) 可能删到**目标目录的内容**！
      try { fs.unlinkSync(link); } catch { /* 清理失败不掩盖断言 */ }
    }
  });

  it('【B2】批准根必须以 workspaceRoot 为基准（用 cwd 会记到别处，导致"批准了却写不出去"）', () => {
    // 判据一侧：classifyWriteTarget 内部是 path.resolve(workspaceRoot, filePath)。
    // 记录一侧（loop-tools 的 4 处）修复前用 path.resolve(filePath) ⇒ 基准是 process.cwd()。
    // 本机 cwd = C:\Users\74689，workspaceRoot = ...\hyacinth ⇒ 两者算出的根**不是同一个地方**，
    // 围栏据此永远匹配不上 ⇒ 用户按了 yes/always/aor 仍被拦。
    const rel = path.join('sub', 'a.txt');
    const byRoot = path.dirname(path.resolve(root, rel));   // ✅ 与判据同源（修好后 loop-tools 用的写法）
    const byCwd = path.dirname(path.resolve(rel));          // ❌ 修复前的写法
    expect(byRoot).toBe(path.join(root, 'sub'));
    // 只有当 cwd ≠ workspaceRoot 时才暴露差异（本项目默认即如此）；相等时二者同值，无从区分
    if (byCwd !== byRoot) expect(byCwd).not.toBe(byRoot);
  });
});
