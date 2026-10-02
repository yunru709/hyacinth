/**
 * grep.test.ts — glob 语义回归
 *
 * 背景（2026-10-02 实测事故）：
 *   `glob: "*.ts"` 曾编译成 `^[^/]*\.ts$` —— 只认顶层文件 ⇒ 对全嵌套的 src/ 一律
 *   回 "No matches"。它**长得像正常空结果**，我差点据此得出"没人引用 http_request"
 *   的反结论。同族缺陷：描述里宣称支持 `{a,b}`，实际把 `{`/`}` 当字面量转义了。
 *   两条都在此钉住。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepTool } from './grep.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'grep-glob-'));
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
  writeFileSync(join(root, 'top.ts'), 'NEEDLE_TOP\n');
  writeFileSync(join(root, 'sub', 'mid.ts'), 'NEEDLE_MID\n');
  writeFileSync(join(root, 'sub', 'deep', 'low.ts'), 'NEEDLE_LOW\n');
  writeFileSync(join(root, 'sub', 'note.md'), 'NEEDLE_MD\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const tool = new GrepTool();

describe('grep glob 语义', () => {
  it('不含 "/" 的 glob 按任意深度匹配（回归：曾静默零命中）', async () => {
    const r = await tool.execute({
      pattern: 'NEEDLE_', path: root, glob: '*.ts', output_mode: 'files_with_matches',
    });
    expect(r).toContain('top.ts');
    expect(r).toContain('mid.ts');
    expect(r).toContain('low.ts');
    expect(r).not.toContain('note.md');
  });

  it('支持 {a,b} 花括号展开（回归：曾被当字面量）', async () => {
    const r = await tool.execute({
      pattern: 'NEEDLE_', path: root, glob: '*.{ts,md}', output_mode: 'files_with_matches',
    });
    expect(r).toContain('low.ts');
    expect(r).toContain('note.md');
  });

  it('含 "/" 的 glob 仍按路径匹配（不跨目录）', async () => {
    const r = await tool.execute({
      pattern: 'NEEDLE_', path: root, glob: 'sub/*.ts', output_mode: 'files_with_matches',
    });
    expect(r).toContain('mid.ts');
    expect(r).not.toContain('low.ts'); // 在 sub/deep/ 下，不该被 sub/*.ts 命中
    expect(r).not.toContain('top.ts');
  });

  it('glob 零命中时明确回报 glob 与扫描数，而不是静默空结果', async () => {
    const r = await tool.execute({
      pattern: 'NEEDLE_', path: root, glob: '*.tss', output_mode: 'files_with_matches',
    });
    expect(r).toContain('No files matched glob "*.tss"');
    expect(r).toContain('scanned');
  });
});
