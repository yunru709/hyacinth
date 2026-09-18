/**
 * python-tree-sitter.test.ts — Python 语法树解析器的验收（Phase 2 交付判据）
 *
 * 用户定的验收线：① 索引里出现 'py-tree-sitter' 出处 ② caller_name 非空 ③ 夹具测试。
 * 另加一条**语法树专属**的硬判据：④ 注释与字符串里的 `helper_a()` 不得成为引用
 *（正则的"误报三兄弟"里，注释与字符串这两道由语法树天然解决）。
 *
 * 隔离：沿用同目录惯例（XrefManager.init 把库固定在 ~/.agent/cache/…，无环境变量开关）
 * → 劫持 os.homedir() 到临时目录。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from '../manager.js';
import { XrefQueryTool } from '../xref-query.js';
import { PyTreeSitterParser } from './python-tree-sitter.js';
import { pythonSupport } from './python.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

const PY_FIXTURE = [
  'import os',
  'from .pkg import thing',
  '',
  'def helper_a():',
  '    return 1',
  '',
  'class Base:',
  '    pass',
  '',
  'class Derived(Base):',
  '    def method(self):',
  '        # helper_a()      ← 注释里的调用不得成为引用',
  '        s = "helper_a()"  # 字符串里的同样不行（也该被忽略）',
  '        return helper_a()',
  '',
  'def helper_b():',
  '    return helper_a()',
  '',
  'def _private():',
  '    return helper_a()',
  '',
].join('\n');

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'py-ts-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

describe('PyTreeSitterParser（语法树解析）', () => {
  let file: string;
  let root: string;

  beforeAll(async () => {
    root = await makeProject({ 'pkg/mod.py': PY_FIXTURE, 'pkg/__init__.py': '' });
    file = path.join(root, 'pkg', 'mod.py');
  });

  it('符号：def / class 取自语法树，方法的 parent_name 指向所在类', async () => {
    const data = await new PyTreeSitterParser().parseFile(file);
    const names = data.symbols.map((s) => s.name);
    expect(names).toContain('helper_a');
    expect(names).toContain('helper_b');
    expect(names).toContain('Base');
    expect(names).toContain('Derived');

    const method = data.symbols.find((s) => s.name === 'method');
    expect(method?.parent_name).toBe('Derived'); // 正则版本给不出这个
    expect(data.symbols.find((s) => s.name === '_private')?.is_exported).toBe(false);
  });

  it('② caller_name 非空：helper_b 调用 helper_a，调用者是 helper_b', async () => {
    const data = await new PyTreeSitterParser().parseFile(file);
    const callATo = data.refs.filter((r) => r.symbol_name === 'helper_a' && r.kind === 'call');
    expect(callATo.length).toBeGreaterThan(0);
    const fromB = callATo.find((r) => r.caller_name === 'helper_b');
    expect(fromB, 'helper_b 里那次调用必须带 caller_name=helper_b').toBeTruthy();
    // 方法内的调用也要能归到方法（Derived.method）
    expect(callATo.some((r) => r.caller_name === 'method')).toBe(true);
  });

  it('④ 注释与字符串里的 helper_a() 不得成为引用（语法树天然解决误报前两道）', async () => {
    const data = await new PyTreeSitterParser().parseFile(file);
    const callATo = data.refs.filter((r) => r.symbol_name === 'helper_a' && r.kind === 'call');
    // 全文出现 5 次 `helper_a()`：注释 1 + 字符串 1 + 真实调用 3
    //（Derived.method 内 / helper_b 内 / _private 内）→ 只有那 3 次该入图
    expect(callATo.length).toBe(3);
  });

  it('继承边：class Derived(Base) → inherit 引用', async () => {
    const data = await new PyTreeSitterParser().parseFile(file);
    const inh = data.refs.filter((r) => r.kind === 'inherit');
    expect(inh.map((r) => r.symbol_name)).toContain('Base');
  });

  it('导入口径与 py-regex 一致（解析侧依赖的契约）', async () => {
    const data = await new PyTreeSitterParser().parseFile(file);
    // `from .pkg import thing` → to_path '.pkg' 带符号
    expect(data.imports).toContainEqual({ to_path: '.pkg', symbols: ['thing'], import_type: 'static' });
    // `import os` → 纯模块路径、不带符号
    expect(data.imports).toContainEqual({ to_path: 'os', symbols: [], import_type: 'static' });
  });

  it('精度链顺序：语法树在前、正则在后（降级可达）', async () => {
    const chain = await pythonSupport.createParsers();
    expect(chain.map((p) => p.name)).toEqual(['py-tree-sitter', 'py-regex']);
  });
});

describe('端到端：索引里的出处与 callers（用户验收线 ①②）', () => {
  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'py-ts-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome);
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('① 构建后库内出处出现 py-tree-sitter；② callers 能列出调用者', async () => {
    const proj = await makeProject({ 'pkg/mod.py': PY_FIXTURE, 'pkg/__init__.py': '' });
    const m = new XrefManager();
    await m.init(proj);
    try {
      const stats = await m.build(undefined, undefined, 50, { force: true });
      // ① 出处：语料里**两个** .py（pkg/mod.py 与 pkg/__init__.py）都必须记成 py-tree-sitter
      //    （不是 py-regex）—— 这正是"降级可查"的另一面：没降级也要看得出来
      expect(stats.parser_breakdown?.['py-tree-sitter']).toBe(2);
      expect(stats.parser_breakdown?.['py-regex']).toBeUndefined();

      // ② caller_name 的用户可见收益：callers 能列出 helper_b
      const out = await new XrefQueryTool(m).execute({ action: 'callers', symbol: 'helper_a' });
      expect(out).toContain('helper_b');
    } finally {
      m.close();
      await fs.rm(proj, { recursive: true, force: true });
    }
  });
});
