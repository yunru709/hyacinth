/**
 * read-structure.test.ts — read 工具的「结构模式」回归点
 *
 * 目标：让"按符号读"和"文件符号大纲"可被验证，而不是靠肉眼。
 * 重点覆盖：区间正确（不多吞、不少吞）、找不到时的引导、以及**二进制优先**。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadTool } from './read.js';

// 项目既有约定：临时目录用 mkdtemp 且**不删**（de-flake 教训）
function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-struct-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const SRC = [
  "import fs from 'node:fs';",
  '',
  'export interface Cfg {',
  '  a: number;',
  '}',
  '',
  'export class Registry {',
  '  private items = new Map<string, number>();',
  '',
  '  register(name: string): void {',
  '    this.items.set(name, 1);',
  '  }',
  '',
  '  async flush(): Promise<void> {',
  '    await Promise.resolve();',
  '  }',
  '}',
  '',
  'export function helper(x: number): number {',
  '  return x * 2;',
  '}',
  '',
  '// 结尾注释，不该被算进 helper 的区间',
  '',
].join('\n');

const tool = new ReadTool();

describe('read 结构模式', () => {
  it('outline=true 给出符号大纲（含行号与 kind）', async () => {
    const p = tmpFile('a.ts', SRC);
    const r = await tool.execute({ file_path: p, outline: true });
    expect(r).toContain('[outline]');
    expect(r).toContain('Cfg');
    expect(r).toContain('Registry');
    expect(r).toContain('register');
    expect(r).toContain('flush');
    expect(r).toContain('helper');
    expect(r).toContain('interface');
    expect(r).toContain('class');
    expect(r).toContain('function');
    // 行号应与源文件一致（Cfg 在第 3 行）
    expect(r).toMatch(/3→interface\s+Cfg/);
  });

  it('outline 在无可识别声明时给出引导而不是空输出', async () => {
    const p = tmpFile('b.txt', 'just some plain text\nno declarations here\n');
    const r = await tool.execute({ file_path: p, outline: true });
    expect(r).toContain('未在');
    expect(r).toContain('提示');
  });

  it('symbol=helper 只返回该函数的区间（不多吞尾部注释）', async () => {
    const p = tmpFile('c.ts', SRC);
    const r = await tool.execute({ file_path: p, symbol: 'helper' });
    expect(r).toContain('export function helper');
    expect(r).toContain('return x * 2;');
    // 区间摘要
    expect(r).toMatch(/symbol "helper" 位于 \d+-\d+ 行/);
    // 不该吞掉后面的注释，也不该包含前面的类
    expect(r).not.toContain('结尾注释');
    expect(r).not.toContain('class Registry');
  });

  it('symbol=Registry 返回整个类（含内部方法）', async () => {
    const p = tmpFile('d.ts', SRC);
    const r = await tool.execute({ file_path: p, symbol: 'Registry' });
    expect(r).toContain('export class Registry');
    expect(r).toContain('register(');
    expect(r).toContain('flush(');
    expect(r).not.toContain('export function helper');
  });

  it('symbol 找不到时引导先用 outline', async () => {
    const p = tmpFile('e.ts', SRC);
    const r = await tool.execute({ file_path: p, symbol: 'noSuchThing' });
    expect(r).toContain('未找到符号');
    expect(r).toContain('outline');
  });

  it('二进制文件仍优先返回 [Binary File]（结构模式不越权）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-struct-bin-'));
    const p = path.join(dir, 'x.bin');
    fs.writeFileSync(p, Buffer.concat([Buffer.alloc(512, 0), Buffer.from('helper()')]));
    const r = await tool.execute({ file_path: p, symbol: 'helper' });
    expect(r).toContain('[Binary File]');
  });

  it('超过结构模式上限时明确拒绝并给替代方案', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-struct-big-'));
    const p = path.join(dir, 'big.ts');
    // 3MB，超过 2MB 上限
    fs.writeFileSync(p, 'export function f() {\n' + '  // pad\n'.repeat(400000) + '}\n', 'utf8');
    const r = await tool.execute({ file_path: p, outline: true });
    expect(r).toContain('文件过大');
    expect(r).toContain('grep');
  });
});
