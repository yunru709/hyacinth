/**
 * probe.test.ts — 探针工具的回归点
 *
 * 最关键的一条是「UTF-16 文件」那个用例：本次整晚排查的第一道坎就是
 * **UTF-16 文件里用 UTF-8 关键字搜索永远零命中且不报错**。探针必须同时按
 * utf8/utf16le/utf16be 构造 needle，并回报命中的是哪一种。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProbeTool } from './probe.js';

// 项目既有约定：临时目录用 mkdtemp 且**不删**（de-flake 教训）
function tmpFile(name: string, content: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const tool = new ProbeTool();

describe('ProbeTool', () => {
  it('在 UTF-8 文本里定位 ASCII 关键字并给上下文', async () => {
    const p = tmpFile('a.txt', 'AAA\nneedle-here\nBBB\n');
    const r = await tool.execute({ file: p, keyword: 'needle-here', before: 8, after: 8 });
    expect(r).toContain('1 hit(s)');
    expect(r).toContain('utf-8');
    expect(r).toContain('needle-here');
    expect(r).toContain('AAA');
  });

  it('在 UTF-8 文本里定位中文关键字', async () => {
    const p = tmpFile('b.txt', '前文：这里是中文关键字的位置。后文\n');
    const r = await tool.execute({ file: p, keyword: '中文关键字' });
    expect(r).toContain('1 hit(s)');
    expect(r).toContain('中文关键字');
  });

  it('在 UTF-16LE 文件里也能搜到（UTF-8 关键字搜索会永远零命中的那个坑）', async () => {
    const p = tmpFile('c.txt', Buffer.from('表头\r\n快照产物已落盘\r\n', 'utf16le'));
    const r = await tool.execute({ file: p, keyword: '快照产物' });
    expect(r).toContain('1 hit(s)');
    expect(r).toContain('utf-16le');
    expect(r).toContain('快照产物已落盘');
  });

  it('UTF-16LE 带 BOM 时给出 BOM 提示', async () => {
    const p = tmpFile('d.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]));
    const r = await tool.execute({ file: p, keyword: 'hello' });
    expect(r).toContain('BOM: UTF-16LE');
    expect(r).toContain('1 hit(s)');
  });

  it('无命中时明确回报 NO HITS 并给排查提示', async () => {
    const p = tmpFile('e.txt', 'nothing interesting here');
    const r = await tool.execute({ file: p, keyword: 'zzz-absent' });
    expect(r).toContain('NO HITS');
    expect(r).toContain('提示');
  });

  it('max_hits 限制返回条数并提示剩余数量', async () => {
    // 命中之间必须拉开距离：探针会合并"相邻/重叠"的命中（去重窗口 32B），
    // 若此处把标记挨着排，10 条会被并成 1 条，max_hits 无从体现。
    const body = Array.from({ length: 10 }, (_, i) => `mark-${i}${'x'.repeat(200)}`).join('\n');
    const p = tmpFile('f.txt', body);
    const r = await tool.execute({ file: p, keyword: 'mark-', max_hits: 3, before: 16, after: 16 });
    expect(r).toContain('more hit(s) not shown');
    expect(r.split('===== HIT').length - 1).toBe(3);
  });

  it('sanitize=ascii 时把非 ASCII 替换为点', async () => {
    const p = tmpFile('g.txt', '中文中文 KEY 中文中文');
    const r = await tool.execute({ file: p, keyword: 'KEY', sanitize: 'ascii' });
    expect(r).toContain('KEY');
    expect(r).not.toContain('中文');
    expect(r).toContain('..');
  });

  it('regex=true 时支持正则定位', async () => {
    const p = tmpFile('h.txt', 'id=42 id=77 id=abc');
    const r = await tool.execute({ file: p, keyword: 'id=\\d+', regex: true });
    expect(r).toContain('id=42');
    expect(r).toContain('id=77');
  });

  it('文件不存在时返回明确错误', async () => {
    const r = await tool.execute({ file: 'C:\\__definitely__missing__\\x.bin', keyword: 'x' });
    expect(r).toContain('file not found');
  });

  it('含 NUL 的二进制不抛异常且给出二进制提示', async () => {
    const buf = Buffer.concat([Buffer.alloc(512, 0), Buffer.from('FINDME'), Buffer.alloc(512, 0)]);
    const p = tmpFile('i.bin', buf);
    const r = await tool.execute({ file: p, keyword: 'FINDME' });
    expect(r).toContain('1 hit(s)');
    expect(r).toContain('FINDME');
    expect(r).toMatch(/NUL/);
  });

  it('缺少必填参数时报错而不是崩', async () => {
    expect(await tool.execute({})).toContain('file is required');
    expect(await tool.execute({ file: __filename })).toContain('keyword is required');
  });
});
