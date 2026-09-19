/**
 * ccpp-tree-sitter.test.ts — C / C++ 语法树解析器的验收（任务单"验收线同 Python"）
 *
 * ① 出处 'ccpp-tree-sitter' ② caller_name 非空 ③ 注释/字符串不产生引用（专测）
 * ④ 结构性边：C++ 的 `class Derived : public Base`（基线 0 条；C 无继承，故只验 C++）
 * ⑤ 导入口径与 GenericParser 逐条一致（**只采引号形式 + import_type='include'**）
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from '../manager.js';
import { XrefQueryTool } from '../xref-query.js';
import { CCppTreeSitterParser } from './ccpp-tree-sitter.js';
import { GenericParser } from '../regex-parser.js';

const C_FIXTURE = [
  '#include "local.h"',
  '#include <stdio.h>',
  '',
  'struct Base { int x; };',
  '',
  'static int helper_fn(void) { return 0; }',
  '',
  'int fake_call(void) { return 1; }',
  '',
  'int use_it(void) {',
  '    fake_call();',
  '    /* fake_call() 注释里的不得成为引用 */',
  '    const char* s = "fake_call()";',
  '    return helper_fn();',
  '}',
  '',
].join('\n');

const CPP_FIXTURE = [
  '#include "local.h"',
  '#include <vector>',
  '',
  'class Base {',
  'public:',
  '    int x;',
  '};',
  '',
  'class Derived : public Base {',
  'public:',
  '    int method() {',
  '        fake_call();',
  '        // fake_call() 注释里的不得成为引用',
  '        const char* s = "fake_call()";',
  '        return helper_fn();',
  '    }',
  '};',
  '',
  'int helper_fn() { return 0; }',
  '',
  'int use_it() { return helper_fn(); }',
  '',
].join('\n');

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccpp-ts-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

describe('CCppTreeSitterParser（语法树解析）', () => {
  let cFile: string;
  let cppFile: string;
  let root: string;

  beforeAll(async () => {
    root = await makeProject({ 'a.c': C_FIXTURE, 'b.cpp': CPP_FIXTURE });
    cFile = path.join(root, 'a.c');
    cppFile = path.join(root, 'b.cpp');
  });

  it('符号：C 的 struct 记 class、函数名沿 declarator 链取到；static 判非导出', async () => {
    const data = await new CCppTreeSitterParser().parseFile(cFile);
    const byName = (n: string) => data.symbols.find((s) => s.name === n);

    expect(byName('Base')?.kind).toBe('class');
    expect(byName('helper_fn')?.kind).toBe('function');
    expect(byName('helper_fn')?.is_exported).toBe(false); // static
    expect(byName('fake_call')?.is_exported).toBe(true);
    expect(data.language).toBe('c');
  });

  it('C++：类内函数记 method 并带 parent_name；class 记 class', async () => {
    const data = await new CCppTreeSitterParser().parseFile(cppFile);
    const byName = (n: string) => data.symbols.find((s) => s.name === n);
    expect(byName('Derived')?.kind).toBe('class');
    expect(byName('method')?.kind).toBe('method');
    expect(byName('method')?.parent_name).toBe('Derived');
    expect(data.language).toBe('cpp');
  });

  it('② caller_name 非空：use_it→helper_fn、类方法内的调用归到该方法', async () => {
    const c = await new CCppTreeSitterParser().parseFile(cFile);
    expect(c.refs.find((r) => r.symbol_name === 'helper_fn')?.caller_name).toBe('use_it');

    const cpp = await new CCppTreeSitterParser().parseFile(cppFile);
    const calls = cpp.refs.filter((r) => r.kind === 'call');
    expect(calls.find((r) => r.symbol_name === 'fake_call')?.caller_name).toBe('method');
    // helper_fn 在夹具里被调用**两次**（method 内 + use_it 内）—— 用 find 只会拿到第一个，
    // 故按"两个调用者都存在"断言（首版用 find 断言 use_it，被自己的用例抓住）
    const helperCallers = calls.filter((r) => r.symbol_name === 'helper_fn').map((r) => r.caller_name);
    expect(helperCallers).toContain('method');
    expect(helperCallers).toContain('use_it');
  });

  it('③ 注释与字符串里的 fake_call() 不产生引用（基线 C 收 3 次、C++ 收 2 次）', async () => {
    const c = await new CCppTreeSitterParser().parseFile(cFile);
    expect(c.refs.filter((r) => r.kind === 'call' && r.symbol_name === 'fake_call').length).toBe(1);
    const baseC = await new GenericParser(['.c']).parseFile(cFile);
    expect(baseC.refs.filter((r) => r.symbol_name === 'fake_call').length).toBe(3);

    const cpp = await new CCppTreeSitterParser().parseFile(cppFile);
    expect(cpp.refs.filter((r) => r.kind === 'call' && r.symbol_name === 'fake_call').length).toBe(1);
    const baseCpp = await new GenericParser(['.cpp']).parseFile(cppFile);
    expect(baseCpp.refs.filter((r) => r.symbol_name === 'fake_call').length).toBe(2);
  });

  it('④ 结构性边：C++ 的 class Derived : public Base（基线 0 条）', async () => {
    const cpp = await new CCppTreeSitterParser().parseFile(cppFile);
    expect(cpp.refs.filter((r) => r.kind === 'inherit').map((r) => r.symbol_name)).toContain('Base');

    const base = await new GenericParser(['.cpp']).parseFile(cppFile);
    expect(base.refs.filter((r) => r.kind === 'inherit').length).toBe(0);
  });

  it('⑤ 导入口径与 GenericParser 逐条一致（只收引号形式 + type=include）', async () => {
    for (const [f, ext] of [[cFile, '.c'], [cppFile, '.cpp']] as const) {
      const mine = await new CCppTreeSitterParser().parseFile(f);
      const base = await new GenericParser([ext]).parseFile(f);
      expect(mine.imports).toEqual(base.imports);
      // 尖括号形式不入图
      expect(mine.imports.map((i) => i.to_path)).toEqual(['local.h']);
      expect(mine.imports[0]?.import_type).toBe('include');
    }
  });

  it('精度链顺序：语法树在前、正则在后', async () => {
    const { ccppSupport } = await import('./ccpp.js');
    const chain = await ccppSupport.createParsers();
    expect(chain.map((p) => p.name)).toEqual(['ccpp-tree-sitter', 'generic-regex']);
  });
});

describe('端到端：C/C++ 的出处与 callers', () => {
  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ccpp-ts-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome);
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('① 出处是 ccpp-tree-sitter（.c 与 .cpp 都走它）；② callers 可用；带 [precise]', async () => {
    const proj = await makeProject({
      'a.c': ['int target(void) { return 1; }', '', 'int mid(void) { return target(); }', ''].join('\n'),
      'b.cpp': CPP_FIXTURE,
    });
    const m = new XrefManager();
    await m.init(proj);
    try {
      const stats = await m.build(undefined, undefined, 50, { force: true });
      expect(stats.parser_breakdown?.['ccpp-tree-sitter']).toBe(2);
      expect(stats.parser_breakdown?.['generic-regex']).toBeUndefined();

      const out = await new XrefQueryTool(m).execute({ action: 'callers', symbol: 'target' });
      expect(out).toContain('mid');
      expect(out).toContain('[precise]');
    } finally {
      m.close();
      await fs.rm(proj, { recursive: true, force: true });
    }
  });
});
