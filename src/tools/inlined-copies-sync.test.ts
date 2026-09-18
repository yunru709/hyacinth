/**
 * inlined-copies-sync.test.ts — 守住「两份内联副本逐字节一致」（方案 A 的护栏）
 *
 * 背景：`symbol-references` 的实现被**有意复制**进 `write.ts` 与 `edit.ts`，
 * 使两个工具互相独立（见 verify-layers 规则 6，以及两份块头部自带的说明）。
 *
 * 方案 A 的代价是重复，而它**唯一真实的弱点**是「两份悄悄分叉」：改了一份忘了另一份，
 * 于是 write 与 edit 对"引用"的理解不一致 —— 而这种 bug 两边单独看都正常，**极难发现**。
 *
 * 本测试把那个弱点变成**立刻可见的失败**：比对两份标记块是否逐字节相同。
 * 若失败，正确处理是把改动**同样**施加到另一份 ——
 * **不要**为了让它变绿而删标记或放宽比对（那就把护栏拆了）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const BEGIN = '// ── [内联副本 begin]';
const END = '// ── [内联副本 end]';

function extractBlock(file: string): string {
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END, i);
  expect(i, `${path.basename(file)} 缺少 begin 标记`).toBeGreaterThan(-1);
  expect(j, `${path.basename(file)} 缺少 end 标记（或在 begin 之前）`).toBeGreaterThan(i);
  return src.slice(i, j + END.length);
}

describe('内联副本一致性（方案 A 的护栏）', () => {
  const here = path.resolve(__dirname);
  const writeBlock = extractBlock(path.join(here, 'write.ts'));
  const editBlock = extractBlock(path.join(here, 'edit.ts'));

  it('write.ts 与 edit.ts 的内联块逐字节一致', () => {
    // 失败时给出可定位的信息，而不是一句"not equal"
    if (writeBlock !== editBlock) {
      const a = writeBlock.split('\n');
      const b = editBlock.split('\n');
      const firstDiff = a.findIndex((l, i) => l !== b[i]);
      expect.fail(
        `两份内联块不一致（首个差异在第 ${firstDiff + 1} 行）：\n` +
          `  write.ts: ${a[firstDiff] ?? '(缺行)'}\n` +
          `  edit.ts : ${b[firstDiff] ?? '(缺行)'}\n` +
          `→ 请把改动同样施加到另一份（不要删标记或放宽比对）。`,
      );
    }
  });

  it('两份块都非平凡（防止把标记套在空块上"骗过"比对）', () => {
    expect(writeBlock.split('\n').length).toBeGreaterThan(300);
    expect(writeBlock).toContain('autoReferenceCheck');
    expect(writeBlock).toContain('scanReferences');
    expect(writeBlock).toContain('findProjectRoot');
  });

  it('两份块都不含 import/export（内联副本只应是模块内的实现）', () => {
    for (const block of [writeBlock, editBlock]) {
      expect(/^\s*(import|export)\s/m.test(block)).toBe(false);
    }
  });
});
