/**
 * read-gate-partial.test.ts — 不变量：**"部分见过"不等于"完整读过"**
 *
 * 背景（2026-09-19 修复的真窟窿）：
 *   `read` 原先**无条件**调 recordFileRead ⇒ 只读 5 行也等于"完整读过" ✗
 *   ⇒ 之后一次 `write` **全量覆盖**会被放行 —— 也就是"看 5 行就能覆盖整份文件"。
 *   而 write 门控的立身之本恰恰是防这个（read-gate.ts 头部：「交出了多少，才允许往下走多少」）。
 *
 * 修后的规则（简单可预期、无隐藏状态）：**只有"要的是整份"才算完整读过**
 *   · 未传 offset/limit 且非 outline/symbol ⇒ 完整（含图片/PDF/二进制桩，否则它们永远无法被覆盖 = 死胡同）
 *   · 传了 offset/limit，或用 outline/symbol ⇒ 部分：只解锁**锚定 edit**，不解锁整份覆盖
 *
 * 三条用例各锁一件事：
 *   ① 机制：分段读不得写入"完整读过"记录
 *   ② 行为：分段读之后，全量覆盖**必须被拒绝**（且拒绝时把内容交出去 —— 下一轮即可成功）
 *   ③ 防回退：分段读之后，**锚定 edit 仍须放行**（那是本门控的有意逃生门，不能被这次修复误伤）
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { getLastReadTime, getAnyReadTime } from './file-tracker.js';

const created: string[] = [];

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

/** 40 行 TS 文件：前 5 行里放一个可锚定的字符串（给"锚定 edit"那条用） */
function makeLongTsFile(dir: string): string {
  const lines = ['export function targetFn(): number {', '  const anchorLine = 1;'];
  for (let i = 0; i < 36; i++) lines.push(`  const v${i} = ${i};`);
  lines.push('  return 0;', '}');
  const p = path.join(dir, 'long.ts');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

afterAll(() => {
  for (const d of created.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('read 分段读 ≠ 完整读过', () => {
  it('① 只读 5 行，不得被记为"完整读过"', async () => {
    const dir = tmpDir('readgate-partial-');
    const file = makeLongTsFile(dir);

    await new ReadTool().execute({ file_path: file, offset: 1, limit: 5 });

    expect(getLastReadTime(file), '分段读被记成了"完整读过"').toBeNull();
    expect(getAnyReadTime(file), '分段读应记为"部分见过"（锚定 edit 靠它放行）').not.toBeNull();
  });

  it('② 只读 5 行之后，全量覆盖必须被拒绝（并且拒绝响应里带着当前内容）', async () => {
    const dir = tmpDir('readgate-partial2-');
    const file = makeLongTsFile(dir);

    await new ReadTool().execute({ file_path: file, offset: 1, limit: 5 });
    const res = await new WriteTool().execute({ file_path: file, content: 'export const replaced = 1;\n' });

    expect(res, '全量覆盖被放行了 —— 那正是"看 5 行就能覆盖整份文件"').toContain('not read yet');
    expect(res, '拒绝时要顺手把内容交出去（教学 + 给料，下一轮即可成功）').toContain('BEGIN CURRENT CONTENT');
  });

  it('③ 防回退：分段读之后，锚定 edit 仍须放行（这是有意的逃生门）', async () => {
    const dir = tmpDir('readgate-partial3-');
    const file = makeLongTsFile(dir);

    await new ReadTool().execute({ file_path: file, offset: 1, limit: 5 });
    const res = await new EditTool().execute({
      file_path: file,
      old_string: '  const anchorLine = 1;',
      new_string: '  const anchorLine = 2;',
    });

    expect(res, '锚定 edit 被误伤了 —— 门控强度应随模式而变（锚定可自校验 ⇒ 部分见过即可）').not.toContain('not read yet');
    expect(fs.readFileSync(file, 'utf8')).toContain('anchorLine = 2;');
  });
});
