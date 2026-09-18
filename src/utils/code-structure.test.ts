/**
 * code-structure.test.ts — 结构探测的回归点
 *
 * 目标：让"这行命中属于哪个函数/类"和"按符号读区间"这两件事可被验证，
 * 而不是靠肉眼看输出。
 */
import { describe, expect, it } from 'vitest';
import { detectLang, outline, findEnclosingDecl, findDeclRange } from './code-structure.js';

const TS_SNIPPET = `import fs from 'node:fs';

// 顶层注释里的假函数 fakeThing() 不该被识别
export interface Cfg {
  a: number;
}

export type Id = string;

export const makeCfg = (): Cfg => ({ a: 1 });

export class Registry {
  private items = new Map<string, number>();

  register(name: string): void {
    this.items.set(name, 1);
  }

  async flush(): Promise<void> {
    await Promise.resolve();
  }
}

export function helper(x: number): number {
  return x * 2;
}
`;

describe('detectLang', () => {
  it('按扩展名判定语言', () => {
    expect(detectLang('a/b.ts')).toBe('ts');
    expect(detectLang('a/b.mjs')).toBe('js');
    expect(detectLang('a/b.py')).toBe('py');
    expect(detectLang('a/b.go')).toBe('go');
    expect(detectLang('a/b.rs')).toBe('rust');
    expect(detectLang('a/b.unknownext')).toBe('other');
  });
});

describe('outline', () => {
  it('提取 TS 声明并按行号升序，注释行里的假函数不被识别', () => {
    const d = outline(TS_SNIPPET, 'ts');
    const names = d.map((x) => x.name);
    expect(names).toContain('Cfg');
    expect(names).toContain('Id');
    expect(names).toContain('makeCfg');
    expect(names).toContain('Registry');
    expect(names).toContain('helper');
    // 注释里的 fakeThing() 不该出现
    expect(names).not.toContain('fakeThing');
    // 行号单调不减
    const lines = d.map((x) => x.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });

  it('识别类方法（带 { 才算定义，避免把调用当定义）', () => {
    const d = outline(TS_SNIPPET, 'ts');
    const kinds = Object.fromEntries(d.map((x) => [x.name, x.kind]));
    expect(kinds['register']).toBe('method');
    expect(kinds['flush']).toBe('method');
  });
});

describe('findEnclosingDecl', () => {
  it('控制流关键字不得被当成声明（E2E 曾输出 "in method if" / "in method for"）', () => {
    const src = [
      'function real(x: number) {',
      '  if (x > 0) {',
      '    for (let i = 0; i < x; i++) {',
      '      console.log(i);',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const names = outline(src, 'ts').map((d) => d.name);
    expect(names).toContain('real');
    expect(names).not.toContain('if');
    expect(names).not.toContain('for');
    // 命中 if/for 内部时，必须回真正的函数 real，而不是 "if"
    expect(findEnclosingDecl(src.split('\n'), 3, 'ts')?.name).toBe('real');
  });

  const lines = TS_SNIPPET.split('\n');

  it('命中行在方法内 → 回最近的 method（而非外层 class）', () => {
    const idx = lines.findIndex((l) => l.includes('this.items.set'));
    const d = findEnclosingDecl(lines, idx, 'ts');
    expect(d?.name).toBe('register');
    expect(d?.kind).toBe('method');
  });

  it('命中行在顶层函数内 → 回该函数', () => {
    const idx = lines.findIndex((l) => l.includes('return x * 2'));
    expect(findEnclosingDecl(lines, idx, 'ts')?.name).toBe('helper');
  });

  it('命中行在文件最顶部（import 之前无声明）→ null', () => {
    expect(findEnclosingDecl(lines, 0, 'ts')).toBeNull();
  });
});

describe('findDeclRange', () => {
  it('TS：按花括号配平给出区间，且区间文本含声明体', () => {
    const lines = TS_SNIPPET.split('\n');
    const r = findDeclRange(lines, 'helper', 'ts');
    expect(r).not.toBeNull();
    const body = lines.slice(r!.start - 1, r!.end).join('\n');
    expect(body).toContain('export function helper');
    expect(body).toContain('return x * 2');
    // 不应把后面无关内容也吞进来（helper 是文件最后一个声明）
    expect(r!.end).toBeLessThanOrEqual(lines.length);
  });

  it('TS：类区间包含内部方法', () => {
    const lines = TS_SNIPPET.split('\n');
    const r = findDeclRange(lines, 'Registry', 'ts');
    const body = lines.slice(r!.start - 1, r!.end).join('\n');
    expect(body).toContain('class Registry');
    expect(body).toContain('register(');
    expect(body).toContain('flush(');
  });

  it('Python：按缩进给出区间', () => {
    const py = [
      'import os',
      '',
      'def outer():',
      '    x = 1',
      '    def inner():',
      '        return x',
      '    return inner',
      '',
      'def after():',
      '    pass',
    ].join('\n');
    const r = findDeclRange(py.split('\n'), 'outer', 'py');
    const body = py.split('\n').slice(r!.start - 1, r!.end).join('\n');
    expect(body).toContain('def outer():');
    expect(body).toContain('def inner():');
    expect(body).not.toContain('def after():');
  });

  it('找不到的名字返回 null', () => {
    expect(findDeclRange(TS_SNIPPET.split('\n'), 'noSuchSymbol', 'ts')).toBeNull();
  });
});
