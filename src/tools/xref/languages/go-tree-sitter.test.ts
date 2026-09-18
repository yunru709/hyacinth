/**
 * go-tree-sitter.test.ts — Go 语法树解析器的验收（任务单"验收线同 Python"）
 *
 * ① 索引里出现 'go-tree-sitter' 出处
 * ② caller_name 非空（方法调用 + 跨函数调用各一例）
 * ③ 注释/字符串中的调用不产生引用（专测 —— 基线 GenericParser 在这一点上是错的）
 * ④ 结构性边：Go 没有继承，等价物是**嵌入**（Base / fmt.Stringer）
 * ⑤ 导入口径与 GenericParser **逐条一致**（直接对同夹具跑两个解析器比对 imports 数组）
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from '../manager.js';
import { XrefQueryTool } from '../xref-query.js';
import { GoTreeSitterParser } from './go-tree-sitter.js';
import { GenericParser } from '../regex-parser.js';

const GO_FIXTURE = [
  'package main',
  '',
  'import (',
  '\t"fmt"',
  '\t"./local"',
  '\t"github.com/x/y"',
  ')',
  '',
  'import "single/pkg"',
  '',
  'type Base struct{ x int }',
  '',
  'type Derived struct {',
  '\tBase',
  '\tfmt.Stringer',
  '}',
  '',
  'func (d *Derived) Method() string {',
  '\tfakeCall()',
  '\t// fakeCall() 注释里的不得成为引用',
  '\ts := "fakeCall()" // 字符串里的同样不行',
  '\treturn fmt.Sprintf("%s", s)',
  '}',
  '',
  'func Helper() int {',
  '\treturn 0',
  '}',
  '',
  'func UseIt() int {',
  '\treturn Helper()',
  '}',
  '',
].join('\n');

const CALLER_FIXTURE = [
  'package main',
  '',
  'func Target() int {',
  '\treturn 1',
  '}',
  '',
  'func Mid() int {',
  '\treturn Target()',
  '}',
  '',
].join('\n');

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'go-ts-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

describe('GoTreeSitterParser（语法树解析）', () => {
  let file: string;
  let root: string;

  beforeAll(async () => {
    root = await makeProject({ 'main.go': GO_FIXTURE });
    file = path.join(root, 'main.go');
  });

  it('符号：func/method/type 分类正确，方法带接收者作为 parent_name，Go 导出看首字母大写', async () => {
    const data = await new GoTreeSitterParser().parseFile(file);
    const byName = (n: string) => data.symbols.find((s) => s.name === n);

    expect(byName('Helper')?.kind).toBe('function');
    expect(byName('Method')?.kind).toBe('method');
    expect(byName('Method')?.parent_name).toBe('Derived'); // 接收者 → parent_name（基线给不出）
    expect(byName('Base')?.kind).toBe('class'); // struct
    expect(byName('Derived')?.kind).toBe('class');
    expect(byName('Helper')?.is_exported).toBe(true); // 首字母大写 = 导出
    expect(data.symbols.every((s) => s.name[0] === '_' || /^[A-Z]/.test(s.name) === s.is_exported)).toBe(true);
  });

  it('② caller_name 非空：UseIt→Helper、Method 内的调用归到 Method', async () => {
    const data = await new GoTreeSitterParser().parseFile(file);
    const calls = data.refs.filter((r) => r.kind === 'call');
    expect(calls.find((r) => r.symbol_name === 'Helper')?.caller_name).toBe('UseIt');
    expect(calls.find((r) => r.symbol_name === 'fakeCall')?.caller_name).toBe('Method');
  });

  it('③ 注释与字符串里的 fakeCall() 不产生引用（基线这里是错的：收了 2 次）', async () => {
    const data = await new GoTreeSitterParser().parseFile(file);
    const fake = data.refs.filter((r) => r.kind === 'call' && r.symbol_name === 'fakeCall');
    expect(fake.length).toBe(1); // 只有第 19 行那次真实调用

    // 对照：基线在同一夹具上会收到 2 次（含字符串里那次）
    const base = await new GenericParser(['.go']).parseFile(file);
    expect(base.refs.filter((r) => r.symbol_name === 'fakeCall').length).toBe(2);
  });

  it('④ 结构性边：嵌入字段（Base / fmt.Stringer）产出 inherit 引用', async () => {
    const data = await new GoTreeSitterParser().parseFile(file);
    const inh = data.refs.filter((r) => r.kind === 'inherit').map((r) => r.symbol_name);
    expect(inh).toContain('Base');
    expect(inh).toContain('Stringer'); // fmt.Stringer 取末段，与 refs 的命名口径一致
  });

  it('⑤ 导入口径与 GenericParser 逐条一致（验收⑤：直接对同一夹具比对）', async () => {
    const mine = await new GoTreeSitterParser().parseFile(file);
    const base = await new GenericParser(['.go']).parseFile(file);
    expect(mine.imports).toEqual(base.imports);
    expect(mine.imports.map((i) => i.to_path)).toEqual(['fmt', './local', 'github.com/x/y', 'single/pkg']);
  });

  it('精度链顺序：语法树在前、正则在后（降级可达）', async () => {
    const { goSupport } = await import('./go.js');
    const chain = await goSupport.createParsers();
    expect(chain.map((p) => p.name)).toEqual(['go-tree-sitter', 'generic-regex']);
  });
});

describe('端到端：Go 的出处与 callers', () => {
  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'go-ts-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome);
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('① 构建后出处是 go-tree-sitter；② callers 能列出调用者', async () => {
    const proj = await makeProject({ 'main.go': CALLER_FIXTURE });
    const m = new XrefManager();
    await m.init(proj);
    try {
      const stats = await m.build(undefined, undefined, 50, { force: true });
      expect(stats.parser_breakdown?.['go-tree-sitter']).toBe(1);
      expect(stats.parser_breakdown?.['generic-regex']).toBeUndefined(); // 没降级

      const out = await new XrefQueryTool(m).execute({ action: 'callers', symbol: 'Target' });
      expect(out).toContain('Mid'); // 调用者可见（基线给不出 caller_name）
      expect(out).toContain('[precise]'); // Phase 3 标注：go-tree-sitter 属语法树档
    } finally {
      m.close();
      await fs.rm(proj, { recursive: true, force: true });
    }
  });
});
