/**
 * verify-change.test.ts — 回归点
 *
 * 刻意**不**在单测里触发真 `tsc`/`vitest`（每次十几秒，会把测试拖垮）。
 * 因此重点覆盖两处最容易藏 bug 的**纯逻辑**：git status 解析、关联测试推导；
 * 工具层只测不产生 spawn 的快路径（非法参数拒绝、无关联测试的明确报告）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerifyChangeTool, parseGitStatus, deriveTestTargets } from './verify-change.js';

describe('parseGitStatus', () => {
  it('解析普通状态行', () => {
    expect(parseGitStatus(' M src/a.ts\n?? src/b.ts\n')).toEqual(['src/a.ts', 'src/b.ts']);
  });
  it('重命名取新路径', () => {
    expect(parseGitStatus('R  src/old.ts -> src/new.ts\n')).toEqual(['src/new.ts']);
  });
  it('去掉 git 给含特殊字符路径加的引号', () => {
    expect(parseGitStatus('?? "src/a b.ts"\n')).toEqual(['src/a b.ts']);
  });
  it('反斜杠归一为正斜杠', () => {
    expect(parseGitStatus(' M src\\tools\\a.ts\n')).toEqual(['src/tools/a.ts']);
  });
  it('忽略空行与过短行', () => {
    expect(parseGitStatus('\n\n M src/a.ts\nx\n')).toEqual(['src/a.ts']);
  });
});

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return root;
}

describe('deriveTestTargets', () => {
  it('共址命名优先：src/a.ts → src/a.test.ts', () => {
    const root = makeRepo({ 'src/a.ts': '', 'src/a.test.ts': '' });
    const r = deriveTestTargets(root, ['src/a.ts']);
    expect(r.files).toEqual(['src/a.test.ts']);
    expect(r.basis).toContain('colocated');
  });

  it('改动文件本身就是测试文件时直接用它', () => {
    const root = makeRepo({ 'src/b.test.ts': '' });
    const r = deriveTestTargets(root, ['src/b.test.ts']);
    expect(r.files).toEqual(['src/b.test.ts']);
  });

  it('无共址测试则退化为同目录测试文件（并说明依据）', () => {
    const root = makeRepo({ 'src/c.ts': '', 'src/d.test.ts': '' });
    const r = deriveTestTargets(root, ['src/c.ts']);
    expect(r.files).toEqual(['src/d.test.ts']);
    expect(r.basis).toContain('sibling');
  });

  it('都找不到时返回空 + basis=none（不静默编造目标）', () => {
    const root = makeRepo({ 'src/e.ts': '' });
    const r = deriveTestTargets(root, ['src/e.ts']);
    expect(r.files).toEqual([]);
    expect(r.basis).toBe('none');
  });
});

describe('VerifyChangeTool（快路径）', () => {
  it('路径含危险元字符 → 直接拒绝，不执行任何命令', async () => {
    const r = await new VerifyChangeTool().execute({ paths: ['src/a.ts; rm -rf /'] });
    expect(r).toContain('illegal path');
  });

  it('接受绝对路径（不做白名单误杀），无关联测试时明确报告而非静默跳过', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-abs-'));
    const f = path.join(root, 'lonely.ts');
    fs.writeFileSync(f, 'export const a = 1;\n', 'utf8');
    const r = await new VerifyChangeTool().execute({ paths: [f], run: 'tests' });
    expect(r).not.toContain('illegal path');
    expect(r).toContain('NO TARGETS');
  });
});
