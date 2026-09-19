/**
 * java-tree-sitter.test.ts — Java 语法树解析器的验收（任务单"验收线同 Python"）
 *
 * ① 出处 'java-tree-sitter' ② caller_name 非空 ③ 注释/字符串不产生引用（专测）
 * ④ 结构性边：extends / implements（基线一条都没抓）⑤ 导入口径与 GenericParser 逐条一致
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from '../manager.js';
import { XrefQueryTool } from '../xref-query.js';
import { JavaTreeSitterParser } from './java-tree-sitter.js';
import { GenericParser } from '../regex-parser.js';

const JAVA_FIXTURE = [
  'package com.demo;',
  '',
  'import java.util.List;',
  'import com.demo.other.Helper;',
  '',
  'public class Base {',
  '    private int x;',
  '}',
  '',
  'public class Derived extends Base implements Runnable {',
  '    public void run() {',
  '        fakeCall();',
  '        // fakeCall() 注释里的不得成为引用',
  '        String s = "fakeCall()";',
  '        Helper.doIt();',
  '    }',
  '',
  '    public int compute() {',
  '        return helperFn();',
  '    }',
  '}',
  '',
  'class Util {',
  '    static int helperFn() { return 0; }',
  '}',
  '',
].join('\n');

const CALLER_FIXTURE = [
  'package com.demo;',
  '',
  'class One {',
  '    void target() { }',
  '}',
  '',
  'class Two {',
  '    void mid(One o) { o.target(); }',
  '}',
  '',
].join('\n');

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'java-ts-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

describe('JavaTreeSitterParser（语法树解析）', () => {
  let file: string;
  let root: string;

  beforeAll(async () => {
    root = await makeProject({ 'com/demo/Main.java': JAVA_FIXTURE });
    file = path.join(root, 'com', 'demo', 'Main.java');
  });

  it('符号：class/method 分类正确，方法带 parent_name，public 判定导出', async () => {
    const data = await new JavaTreeSitterParser().parseFile(file);
    const byName = (n: string) => data.symbols.find((s) => s.name === n);

    expect(byName('Base')?.kind).toBe('class');
    expect(byName('Derived')?.kind).toBe('class');
    expect(byName('run')?.kind).toBe('method');
    expect(byName('run')?.parent_name).toBe('Derived');
    expect(byName('Base')?.is_exported).toBe(true); // public class
    expect(byName('Util')?.is_exported).toBe(false); // 无 public
    expect(byName('run')?.is_exported).toBe(true); // public void run
  });

  it('② caller_name 非空：方法内的调用归到所属方法', async () => {
    const data = await new JavaTreeSitterParser().parseFile(file);
    const calls = data.refs.filter((r) => r.kind === 'call');
    expect(calls.find((r) => r.symbol_name === 'fakeCall')?.caller_name).toBe('run');
    expect(calls.find((r) => r.symbol_name === 'doIt')?.caller_name).toBe('run');
    expect(calls.find((r) => r.symbol_name === 'helperFn')?.caller_name).toBe('compute');
  });

  it('③ 注释与字符串里的 fakeCall() 不产生引用（基线收 2 次）', async () => {
    const data = await new JavaTreeSitterParser().parseFile(file);
    const fake = data.refs.filter((r) => r.kind === 'call' && r.symbol_name === 'fakeCall');
    expect(fake.length).toBe(1);

    const base = await new GenericParser(['.java']).parseFile(file);
    expect(base.refs.filter((r) => r.symbol_name === 'fakeCall').length).toBe(2);
  });

  it('④ 结构性边：extends Base / implements Runnable（基线 0 条）', async () => {
    const data = await new JavaTreeSitterParser().parseFile(file);
    const inh = data.refs.filter((r) => r.kind === 'inherit').map((r) => r.symbol_name);
    expect(inh).toContain('Base');
    expect(inh).toContain('Runnable');

    const base = await new GenericParser(['.java']).parseFile(file);
    expect(base.refs.filter((r) => r.kind === 'inherit').length).toBe(0);
  });

  it('⑤ 导入口径与 GenericParser 逐条一致（同夹具直接比对）', async () => {
    const mine = await new JavaTreeSitterParser().parseFile(file);
    const base = await new GenericParser(['.java']).parseFile(file);
    expect(mine.imports).toEqual(base.imports);
    expect(mine.imports.map((i) => i.to_path)).toEqual(['java.util.List', 'com.demo.other.Helper']);
  });

  it('精度链顺序：语法树在前、正则在后', async () => {
    const { javaSupport } = await import('./java.js');
    const chain = await javaSupport.createParsers();
    expect(chain.map((p) => p.name)).toEqual(['java-tree-sitter', 'generic-regex']);
  });
});

describe('端到端：Java 的出处与 callers', () => {
  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'java-ts-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome);
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('① 出处是 java-tree-sitter；② callers 能列出调用者；带 [precise]', async () => {
    const proj = await makeProject({ 'com/demo/Two.java': CALLER_FIXTURE });
    const m = new XrefManager();
    await m.init(proj);
    try {
      const stats = await m.build(undefined, undefined, 50, { force: true });
      expect(stats.parser_breakdown?.['java-tree-sitter']).toBe(1);
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
