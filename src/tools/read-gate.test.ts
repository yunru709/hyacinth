/**
 * read-gate.test.ts — 「拒绝即给料」的回归点
 *
 * 这套行为是**数据驱动**改出来的：真实语料 647 次调用 / 16 次可辩护失败里，11 次是
 * "write/edit 要求先读过" 且状态随重启失忆。改法是把惩罚变成教学 + 给料（3 轮压到 2 轮），
 * 但必须守住一条安全边界：**交出了多少，才允许往下走多少。**
 *
 * 因此本文件里最要紧的是**两条防陷阱回归**（第 2、3 例）：
 *   - 大文件只给片段 → 下一轮 **write 仍必须被拒**（否则可能把没看到的中段静默写没）
 *   - 但同一状态 **足以放行 edit**（锚定替换不会丢内容）
 * 这两条一旦被后来的改动"简化"掉，就会静默丢数据 —— 所以锁在这里。
 *
 * 隔离方式：每个用例用自己的临时文件路径 —— 门控是进程内按路径记账，路径不同即天然隔离。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { recordFileRead } from './file-tracker.js';

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgate-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const BIG = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'); // 远超 12k

describe('write 门控：拒绝即给料', () => {
  it('小文件未读 → 拒绝但交出全文，且下一轮直接成功（3 轮 → 2 轮）', async () => {
    const p = tmpFile('small.txt', 'alpha\nbeta\ngamma\n');
    const tool = new WriteTool();

    const first = await tool.execute({ file_path: p, content: 'REPLACED\n' });
    expect(first).toContain('not read yet');
    expect(first).toContain('BEGIN CURRENT CONTENT');
    expect(first).toContain('alpha');          // 全文已交出
    expect(first).toContain('re-issue the same call');   // 措辞通用化：write 与行模式共用同一响应
    expect(fs.readFileSync(p, 'utf8')).toContain('alpha');  // 拒绝时一个字都没改

    const second = await tool.execute({ file_path: p, content: 'REPLACED\n' });
    expect(second).not.toContain('not read yet');           // 已放行
    expect(fs.readFileSync(p, 'utf8')).toBe('REPLACED\n');
  });

  it('⚠️ 大文件未读 → 只给头尾，且下一轮 write **仍被拒**（防"片段放行"陷阱）', async () => {
    const p = tmpFile('big.txt', BIG);
    const tool = new WriteTool();

    const first = await tool.execute({ file_path: p, content: 'whole-file-overwrite\n' });
    expect(first).toContain('Too large to inline');
    expect(first).toContain('STILL BLOCKED');
    expect(first).toContain('FIRST 40 LINES');
    expect(first).toContain('LAST 20 LINES');

    const second = await tool.execute({ file_path: p, content: 'whole-file-overwrite\n' });
    expect(second).toContain('not read yet');               // 仍被拒 —— 这是安全底线
    expect(fs.readFileSync(p, 'utf8').length).toBe(BIG.length); // 内容原封不动
  });

  it('⚠️ 大文件被拒后，同一状态足以放行 edit（锚定替换不丢内容）', async () => {
    const p = tmpFile('big2.txt', BIG);
    const writeTool = new WriteTool();
    await writeTool.execute({ file_path: p, content: 'x\n' }); // 触发 partial

    const editTool = new EditTool();
    const r = await editTool.execute({ file_path: p, old_string: 'line 5 ', new_string: 'line 5 EDITED ' });
    expect(r).not.toContain('not read yet');                // edit 被放行
    expect(fs.readFileSync(p, 'utf8')).toContain('line 5 EDITED');
  });

  it('文件被外部改过 → 拒绝并交出当前内容（真实安全信号，不是形式）', async () => {
    const p = tmpFile('stale.txt', 'v1\n');
    recordFileRead(p);
    await new Promise((r) => setTimeout(r, 80));             // 越过 50ms 容差
    fs.writeFileSync(p, 'v2-external-change\n', 'utf8');

    const r = await new WriteTool().execute({ file_path: p, content: 'mine\n' });
    expect(r).toContain('changed on disk');
    expect(r).toContain('v2-external-change');               // 把现状交出去
  });

  it('真读过之后，write 直接成功（原有路径未被破坏）', async () => {
    const p = tmpFile('ok.txt', 'old\n');
    recordFileRead(p);
    const r = await new WriteTool().execute({ file_path: p, content: 'new\n' });
    expect(r).not.toContain('not read yet');
    expect(fs.readFileSync(p, 'utf8')).toBe('new\n');
  });
});

describe('edit 门控：交出锚点上下文', () => {
  it('未读 + old_string 唯一命中 → 给出命中行与上下文，下一轮成功', async () => {
    const body = ['aaa', 'target-line', 'ccc', 'ddd'].join('\n') + '\n';
    const p = tmpFile('e1.txt', body);
    const tool = new EditTool();

    const first = await tool.execute({ file_path: p, old_string: 'target-line', new_string: 'TARGET' });
    expect(first).toContain('not read yet');
    expect(first).toContain('occurs at line 2');
    expect(first).toContain('CONTEXT');
    expect(first).toContain('target-line');                  // 上下文已交出
    expect(fs.readFileSync(p, 'utf8')).toContain('target-line'); // 未改动

    const second = await tool.execute({ file_path: p, old_string: 'target-line', new_string: 'TARGET' });
    expect(second).not.toContain('not read yet');
    expect(fs.readFileSync(p, 'utf8')).toContain('TARGET');
  });

  it('未读 + old_string **未命中** → 明确指出"你的假设是错的"（比报错有用）', async () => {
    const p = tmpFile('e2.txt', 'real-content\nanother\n');
    const r = await new EditTool().execute({ file_path: p, old_string: 'i-imagined-this', new_string: 'x' });
    expect(r).toContain('NOT FOUND');
    expect(r).toContain('assumption about this file');
    expect(r).toContain('real-content');                     // 顺手给出真实开头
  });

  it('未读 + old_string 多处命中 → 提示不唯一并给出行号列表', async () => {
    const p = tmpFile('e3.txt', 'dup\ndup\ndup\n');
    const r = await new EditTool().execute({ file_path: p, old_string: 'dup', new_string: 'z' });
    expect(r).toContain('NOT unique');
    expect(r).toContain('1, 2, 3');
  });

  it('⚠️ 行模式（无锚点）与 write 同等严格：只给片段后仍必须被拒', async () => {
    const p = tmpFile('e4.txt', BIG);
    const tool = new EditTool();
    const args = { file_path: p, line_start: 200, line_count: 1, new_string: 'REPLACED' };

    const first = await tool.execute(args);
    expect(first).toContain('Too large to inline');   // 无锚点 → 与 write 同一套响应
    expect(first).toContain('STILL BLOCKED');

    const second = await tool.execute(args);
    expect(second).toContain('not read yet');         // 没有被 partial 放行 —— 安全底线
    expect(fs.readFileSync(p, 'utf8').length).toBe(BIG.length);
  });
});
