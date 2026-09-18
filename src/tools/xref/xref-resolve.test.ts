/**
 * xref-resolve.test.ts —— 说明符解析、桶文件透传、同步构建、调用图限定域、多语言
 *
 * 这一批测试针对的缺陷（全部实测复现过）：
 *   A. `resolveImportPath` 只往路径尾部拼扩展名 ⇒ `from './x.js'` 永远不命中。
 *      本项目 2617 条相对导入全是这种写法，imports 表恒为 0，
 *      deps/dependents/impact/symbol_search/文件依赖图 全部空转。
 *   B. ts-parser 只处理 ImportDeclaration ⇒ `export * from` 的桶文件透传边全丢，
 *      动态 `import()` 也不采集。
 *   C. Python：`from .pkg import x` 被拼成 `<dir>/.pkg.py`（带前导点的文件名）；
 *      `from . import x` 正则完全不匹配；绝对导入不采集 —— Python 依赖图整体为空。
 *   D. C `#include "x.h"`（不以点开头）被 `startsWith('.')` 挡掉。
 *   E. Go：正则要求路径以点开头 + `.slice(1,-1)` 削掉首尾字符（`"./foo"` → `/fo`）。
 *   F. Rust `use` / Java `import` / Kotlin / Swift 完全没有采集分支。
 *   G. `callers` 纯名字匹配 ⇒ 同名异实体全算调用者（实测命中 vendor 打包产物）。
 *   H. 未解析导入被静默丢弃，缺边不可见。
 *   I. 全量构建每次都清库重建（本项目 663 文件约 12s）⇒ agent 不敢频繁调用，索引悄悄变旧。
 *
 * 隔离约定与 xref-tools.test.ts 一致：劫持 os.homedir() 到临时目录，
 * init() 后立即断言库落在临时 home 内，否则抛错中止。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { XrefManager } from './manager.js';
import { XrefBuildTool } from './xref-build.js';
import { XrefQueryTool } from './xref-query.js';
import { XrefGraphTool } from './xref-graph.js';

const norm = (p: string) => p.replace(/\\/g, '/');

let tmpRoot: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

// ─── 多语言夹具 ────────────────────────────────────────────────────────

const FIXTURES: Record<string, string> = {
  // ── TS/JS：ESM .js 说明符（缺陷 A 的核心场景）──
  'src/b.ts': [
    'export function helperA(): number {',
    '  return 1;',
    '}',
    '',
    'export function helperB(): number {',
    '  const v = helperA();',
    '  return v;',
    '}',
    '',
  ].join('\n'),
  'src/a.ts': [
    "import { helperB } from './b.js';",
    '',
    'export function main(): number {',
    '  return helperB();',
    '}',
    '',
  ].join('\n'),
  // 目录 index 解析
  'src/dir/index.ts': ['export const dirVal = 1;', ''].join('\n'),
  'src/needsDir.ts': ["import { dirVal } from './dir';", '', 'export const usesDir = dirVal;', ''].join('\n'),
  // 桶文件透传（缺陷 B）
  'src/barrel.ts': [
    "export * from './b.js';",
    "export { helperA as aliased } from './b.js';",
    '',
  ].join('\n'),
  // 经桶文件间接使用（callers 的「已确认」需要 2 跳可达）
  'src/viaBarrel.ts': [
    "import { helperB } from './barrel.js';",
    '',
    'export function viaBarrel(): number {',
    '  return helperB();',
    '}',
    '',
  ].join('\n'),
  // 动态导入（缺陷 B）
  'src/dyn.ts': [
    'export async function load(): Promise<unknown> {',
    "  return import('./b.js');",
    '}',
    '',
  ].join('\n'),
  // 仅同名、无导入关系（缺陷 G 的反例样本）
  'src/isolated.ts': [
    'const obj = { helperB: () => 3 };',
    '',
    'export function useLocal(): number {',
    '  return obj.helperB();',
    '}',
    '',
  ].join('\n'),
  // 未解析导入（缺陷 H）
  'src/missing.ts': ["import { nope } from './does-not-exist.js';", '', 'export const y = nope;', ''].join('\n'),
  'src/reexportMissing.ts': ["export * from './also-missing.js';", ''].join('\n'),

  // ── Python（缺陷 C）──
  'pkg/__init__.py': '',
  'pkg/mod_b.py': ['def py_helper():', '    return 1', ''].join('\n'),
  'pkg/mod_a.py': ['from .mod_b import py_helper', '', 'def py_main():', '    return py_helper()', ''].join('\n'),
  'pkg/mod_c.py': ['from . import mod_b', '', 'def use_mod():', '    return mod_b.py_helper()', ''].join('\n'),
  'main.py': ['from pkg.mod_a import py_main', '', 'py_main()', ''].join('\n'),

  // ── Rust（缺陷 F）：crate:: 映射到 src/ ──
  'src/rslib/lib.rs': [
    'pub mod util;',
    '',
    'use crate::rslib::util::helper_rs;',
    '',
    'pub fn root_fn() -> i32 {',
    '    helper_rs()',
    '}',
    '',
  ].join('\n'),
  'src/rslib/util.rs': ['pub fn helper_rs() -> i32 {', '    1', '}', ''].join('\n'),

  // ── Go（缺陷 E）：monorepo 子模块 ──
  'go/go.mod': ['module example.com/demo', '', 'go 1.21', ''].join('\n'),
  'go/pkg/b/b.go': ['package b', '', 'func Bee() int { return 1 }', ''].join('\n'),
  'go/pkg/a/a.go': [
    'package a',
    '',
    'import (',
    '\t"example.com/demo/pkg/b"',
    ')',
    '',
    'func Aye() int { return b.Bee() }',
    '',
  ].join('\n'),
  'go/cmd/main.go': [
    'package main',
    '',
    'import "example.com/demo/pkg/a"',
    '',
    'func main() { a.Aye() }',
    '',
  ].join('\n'),

  // ── Java（缺陷 F）──
  'src/main/java/com/demo/Bar.java': [
    'package com.demo;',
    '',
    'public class Bar {',
    '    public int bee() { return 1; }',
    '}',
    '',
  ].join('\n'),
  'src/main/java/com/demo/Foo.java': [
    'package com.demo;',
    '',
    'import com.demo.Bar;',
    '',
    'public class Foo {',
    '    public int foo() { Bar b = new Bar(); return b.bee(); }',
    '}',
    '',
  ].join('\n'),

  // ── Kotlin ──
  'src/main/kotlin/com/demo/KUtil.kt': ['package com.demo', '', 'fun kHelper(): Int { return 1 }', ''].join('\n'),
  'src/main/kotlin/com/demo/KApp.kt': [
    'package com.demo',
    '',
    'import com.demo.KUtil',
    '',
    'fun kMain(): Int { return kHelper() }',
    '',
  ].join('\n'),

  // ── C（缺陷 D）──
  'c/hdr.h': ['#ifndef HDR_H', '#define HDR_H', 'int add_ints(int a, int b);', '#endif', ''].join('\n'),
  'c/main.c': ['#include "hdr.h"', '', 'int main(void) { return add_ints(1, 2); }', ''].join('\n'),

  // ── Swift ──
  'swift/App.swift': ['import Foundation', '', 'func swHelper() -> Int { return 1 }', ''].join('\n'),
};

async function writeFixtures(root: string): Promise<void> {
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  }
}

async function createIsolatedManager(tag: string): Promise<{ mgr: XrefManager; root: string }> {
  const root = path.join(tmpRoot, `proj-${tag}`);
  await fs.mkdir(root, { recursive: true });
  await writeFixtures(root);

  const mgr = new XrefManager();
  await mgr.init(root);

  const dbPath = (mgr as unknown as { dbPath: string }).dbPath;
  if (!norm(dbPath).startsWith(norm(fakeHome))) {
    throw new Error(`[隔离失败] xref 库落在 ${dbPath}，不在临时 home 内 —— 中止以免污染真实 ~/.agent`);
  }
  return { mgr, root };
}

beforeAll(async () => {
  tmpRoot = path.join(os.tmpdir(), `hyacinth-xref-resolve-${crypto.randomUUID()}`);
  fakeHome = path.join(tmpRoot, 'home');
  await fs.mkdir(fakeHome, { recursive: true });
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterAll(async () => {
  homedirSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

// =====================================================================
// A. TS/JS 说明符解析
// =====================================================================

describe('TS/JS 说明符解析', () => {
  let mgr: XrefManager;
  let query: XrefQueryTool;
  let build: XrefBuildTool;

  beforeAll(async () => {
    const created = await createIsolatedManager('ts');
    mgr = created.mgr;
    query = new XrefQueryTool(mgr);
    build = new XrefBuildTool(mgr);
    await build.execute({});
  });

  afterAll(() => { try { mgr.close(); } catch { /* ignore */ } });

  it('ESM ".js" 说明符解析到 .ts 源文件（修复前 imports 恒为 0）', async () => {
    const deps = await query.execute({ action: 'deps', file: 'src/a.ts' });
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('[static]');
  });

  it('dependents 反映真实反向依赖', async () => {
    const dependents = await query.execute({ action: 'dependents', file: 'src/b.ts' });
    expect(dependents).toContain('src/a.ts');
    expect(dependents).toContain('src/barrel.ts');
    expect(dependents).toContain('src/dyn.ts');
  });

  it('目录说明符回退到 index.ts', async () => {
    const deps = await query.execute({ action: 'deps', file: 'src/needsDir.ts' });
    expect(deps).toContain('src/dir/index.ts');
  });

  it('impact 的 BFS 影响面可用（修复前恒为空结果）', async () => {
    const impact = await query.execute({ action: 'impact', file: 'src/b.ts', depth: 2 });
    expect(impact).toContain('Layer 1');
    expect(impact).toContain('src/a.ts');
    expect(impact).toMatch(/Total: \d+ files/);
  });

  it('symbol_search 能查到导入指定符号的文件', async () => {
    const found = await query.execute({ action: 'symbol_search', symbol: 'helperB' });
    expect(found).toContain('src/a.ts');
    expect(found).toContain('→');
  });
});

// =====================================================================
// B. 桶文件透传 / 动态导入
// =====================================================================

describe('桶文件透传与动态导入', () => {
  let mgr: XrefManager;
  let query: XrefQueryTool;

  beforeAll(async () => {
    const created = await createIsolatedManager('barrel');
    mgr = created.mgr;
    query = new XrefQueryTool(mgr);
    await new XrefBuildTool(mgr).execute({});
  });

  afterAll(() => { try { mgr.close(); } catch { /* ignore */ } });

  it('export * from / export { x } from 记成 reexport 边', async () => {
    const deps = await query.execute({ action: 'deps', file: 'src/barrel.ts' });
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('[reexport]');
  });

  it('动态 import() 记成 dynamic 边', async () => {
    const deps = await query.execute({ action: 'deps', file: 'src/dyn.ts' });
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('[dynamic]');
  });

  it('经桶文件（2 跳）间接使用的调用者算「已确认」', async () => {
    const callers = await query.execute({ action: 'callers', symbol: 'helperB' });
    expect(callers).toContain('已确认');
    expect(callers).toContain('src/viaBarrel.ts');
  });
});

// =====================================================================
// G. 调用图限定域 + file 范围
// =====================================================================

describe('调用图限定域', () => {
  let mgr: XrefManager;
  let query: XrefQueryTool;

  beforeAll(async () => {
    const created = await createIsolatedManager('scope');
    mgr = created.mgr;
    query = new XrefQueryTool(mgr);
    await new XrefBuildTool(mgr).execute({});
  });

  afterAll(() => { try { mgr.close(); } catch { /* ignore */ } });

  it('callers 把「无导入关系的同名调用」单列，不混进已确认', async () => {
    const callers = await query.execute({ action: 'callers', symbol: 'helperB' });
    // 已确认段包含真实调用者
    const confirmedPart = callers.split('── 仅同名')[0];
    expect(confirmedPart).toContain('src/a.ts');
    expect(confirmedPart).not.toContain('src/isolated.ts');

    // 同名段包含无导入关系的 obj.helperB()
    expect(callers).toContain('仅同名');
    expect(callers).toContain('src/isolated.ts');
  });

  it('callers 支持用 file 钉住定义来消歧重名符号', async () => {
    // helperB 只在 src/b.ts 定义；isolated.ts 的 obj.helperB() 是另一个实体
    const pinned = await query.execute({ action: 'callers', symbol: 'helperB', file: 'src/b.ts' });
    expect(pinned).toContain('[定义限定: src/b.ts]');
    // 钉住定义后，与 b.ts 无导入关系的同名调用不再可能被算作已确认
    const confirmedPart = pinned.split('── 仅同名')[0];
    expect(confirmedPart).toContain('src/a.ts');
    expect(confirmedPart).not.toContain('src/isolated.ts');
  });

  it('callers 的 file 若不含该符号定义，退化为"只看该文件内的引用"', async () => {
    const out = await query.execute({ action: 'callers', symbol: 'helperB', file: 'src/isolated.ts' });
    expect(out).not.toContain('[定义限定:');
    expect(out).toContain('src/isolated.ts');
    expect(out).not.toContain('src/a.ts');
  });

  it('refs 支持 file 参数限定范围（此前描述承诺但未实现）', async () => {
    const scoped = await query.execute({ action: 'refs', symbol: 'helperA', file: 'src/b.ts' });
    expect(scoped).toContain('src/b.ts');
    expect(scoped).not.toContain('src/a.ts');

    const none = await query.execute({ action: 'refs', symbol: 'helperA', file: 'src/a.ts' });
    expect(none).toContain('No references');
  });

  it('defs 支持 file 参数，且在 kind 过滤清空时说明已存在的 kind', async () => {
    const scoped = await query.execute({ action: 'defs', symbol: 'helperA', file: 'src/b.ts' });
    expect(scoped).toContain('src/b.ts');

    const wrongKind = await query.execute({ action: 'defs', symbol: 'helperA', kind: 'class' });
    expect(wrongKind).toContain('No definition of "helperA" with kind "class"');
    expect(wrongKind).toContain('Existing kinds: function');
  });

  it('callers/defs 的 file 不存在时给出明确错误', async () => {
    expect(await query.execute({ action: 'callers', symbol: 'helperB', file: 'src/nope.ts' }))
      .toContain('File not in index');
    expect(await query.execute({ action: 'defs', symbol: 'helperB', file: 'src/nope.ts' }))
      .toContain('File not in index');
  });

  it('impact 的 symbol 参数是标注而非过滤（与描述一致）', async () => {
    const impact = await query.execute({ action: 'impact', file: 'src/b.ts', symbol: 'helperA', depth: 2 });
    expect(impact).toContain('标注引用 "helperA"');
    expect(impact).toContain('其中直接引用 "helperA" 的');
  });
});

// =====================================================================
// H. 未解析导入可见
// =====================================================================

describe('未解析导入可见性', () => {
  let mgr: XrefManager;

  beforeAll(async () => {
    const created = await createIsolatedManager('unresolved');
    mgr = created.mgr;
  });

  afterAll(() => { try { mgr.close(); } catch { /* ignore */ } });

  it('构建结果报告未解析的项目内说明符，并给出样例', async () => {
    const out = await new XrefBuildTool(mgr).execute({});
    expect(out).toContain('Unresolved imports: 2');
    expect(out).toContain('does-not-exist.js');
    expect(out).toContain('also-missing.js');
    // 裸包名不在此列（ts-parser 本就不采集非相对说明符）
    expect(out).not.toContain('some-lib');
  });

  it('未解析导入不产生边，但也不影响其它边', async () => {
    const deps = await new XrefQueryTool(mgr).execute({ action: 'deps', file: 'src/missing.ts' });
    expect(deps).toMatch(/has no tracked dependencies/);
    const good = await new XrefQueryTool(mgr).execute({ action: 'deps', file: 'src/a.ts' });
    expect(good).toContain('src/b.ts');
  });
});

// =====================================================================
// I. 同步构建（mtime / 新增 / 删除 / force）
// =====================================================================

describe('同步构建', () => {
  let mgr: XrefManager;
  let root: string;
  let build: XrefBuildTool;

  beforeAll(async () => {
    const created = await createIsolatedManager('sync');
    mgr = created.mgr;
    root = created.root;
    build = new XrefBuildTool(mgr);
    await build.execute({});
  });

  afterAll(() => { try { mgr.close(); } catch { /* ignore */ } });

  it('重复构建：mtime 未变的文件跳过解析，但统计仍反映索引总量', async () => {
    const out = await build.execute({});
    expect(out).toContain('sync (mtime-based)');
    expect(out).toMatch(/Parsed now:\s+0/);
    expect(out).toMatch(/Unchanged:\s+\d+/);
    // 关键：不能因为"没解析"就把 Symbols/Import edges 报成 0
    expect(out).not.toMatch(/Symbols found:\s+0\b/);
    expect(out).not.toMatch(/Import edges:\s+0\b/);
  });

  it('文件内容变更后只重解析该文件', async () => {
    const target = path.join(root, 'src', 'b.ts');
    await fs.writeFile(target, `${await fs.readFile(target, 'utf-8')}\nexport const bumped = 1;\n`, 'utf-8');
    // 显式把 mtime 推到未来，避免同毫秒写入导致 mtime 相等而漏判
    const future = new Date(Date.now() + 5000);
    await fs.utimes(target, future, future);

    const out = await build.execute({});
    expect(out).toMatch(/Parsed now:\s+1/);
    expect(await new XrefQueryTool(mgr).execute({ action: 'defs', symbol: 'bumped' }))
      .toContain('Definition(s) of "bumped"');
  });

  it('文件被删除后从索引中摘除', async () => {
    await fs.rm(path.join(root, 'src', 'dyn.ts'), { force: true });
    const out = await build.execute({});
    expect(out).toContain('Removed:         1');
    expect(await new XrefQueryTool(mgr).execute({ action: 'defs', symbol: 'load' }))
      .toContain('No definition of "load"');
  });

  it('force=true 忽略 mtime 全量重解析', async () => {
    const out = await build.execute({ force: true });
    expect(out).toContain('force full rebuild');
    expect(out).toMatch(/Parsed now:\s+(\d+)/);
    const parsed = Number(/Parsed now:\s+(\d+)/.exec(out)![1]);
    expect(parsed).toBeGreaterThan(5);
    expect(out).not.toContain('Unchanged:');
  });
});

// =====================================================================
// C/D/E/F. 多语言说明符解析
// =====================================================================

describe('多语言说明符解析', () => {
  let mgr: XrefManager;
  let query: XrefQueryTool;
  let buildOut: string;

  beforeAll(async () => {
    const created = await createIsolatedManager('polyglot');
    mgr = created.mgr;
    query = new XrefQueryTool(mgr);
    buildOut = await new XrefBuildTool(mgr).execute({});
  });

  afterAll(() => { try { mgr.close(); } catch { /* ignore */ } });

  it('构建覆盖全部已注册语言（无"注册了扩展名却零实现"的空转）', () => {
    for (const lang of ['typescript', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'c']) {
      expect(buildOut).toContain(`${lang}:`);
    }
  });

  it('Python：相对导入 from .mod_b import f', async () => {
    const deps = await query.execute({ action: 'deps', file: 'pkg/mod_a.py' });
    expect(deps).toContain('pkg/mod_b.py');
  });

  it('Python：from . import mod_b（点后无模块名，导入同级子模块）', async () => {
    const deps = await query.execute({ action: 'deps', file: 'pkg/mod_c.py' });
    expect(deps).toContain('pkg/mod_b.py');
  });

  it('Python：绝对导入 from pkg.mod_a import f', async () => {
    const deps = await query.execute({ action: 'deps', file: 'main.py' });
    expect(deps).toContain('pkg/mod_a.py');
  });

  it('Python：import os 之类外部模块不再被伪造成符号', async () => {
    const defs = await query.execute({ action: 'defs', symbol: 'os' });
    expect(defs).toContain('No definition of');
  });

  it('Rust：crate:: 映射到 src/，mod 声明映射到同级文件', async () => {
    const deps = await query.execute({ action: 'deps', file: 'src/rslib/lib.rs' });
    expect(deps).toContain('src/rslib/util.rs');
    expect(await query.execute({ action: 'defs', symbol: 'helper_rs' }))
      .toContain('Definition(s) of "helper_rs"');
  });

  it('Go：块式与单行 import 都按 module path 映射（修复前路径被 slice 削坏）', async () => {
    const blockForm = await query.execute({ action: 'deps', file: 'go/pkg/a/a.go' });
    expect(blockForm).toContain('go/pkg/b/b.go');

    const singleForm = await query.execute({ action: 'deps', file: 'go/cmd/main.go' });
    expect(singleForm).toContain('go/pkg/a/a.go');
  });

  it('Go：dependents 反向可用（依赖图真正建立起来了）', async () => {
    const dependents = await query.execute({ action: 'dependents', file: 'go/pkg/b/b.go' });
    expect(dependents).toContain('go/pkg/a/a.go');
  });

  it('Java：import com.demo.Bar 按 source root 映射', async () => {
    const deps = await query.execute({ action: 'deps', file: 'src/main/java/com/demo/Foo.java' });
    expect(deps).toContain('src/main/java/com/demo/Bar.java');
  });

  it('Kotlin：import 与 fun 符号都被采集', async () => {
    const deps = await query.execute({ action: 'deps', file: 'src/main/kotlin/com/demo/KApp.kt' });
    expect(deps).toContain('src/main/kotlin/com/demo/KUtil.kt');
    expect(await query.execute({ action: 'defs', symbol: 'kHelper' }))
      .toContain('Definition(s) of "kHelper"');
  });

  it('C：#include "hdr.h" 按同目录解析（修复前被 startsWith(".") 挡掉）', async () => {
    const deps = await query.execute({ action: 'deps', file: 'c/main.c' });
    expect(deps).toContain('c/hdr.h');
    expect(deps).toContain('[include]');
  });

  it('Swift：函数符号可提取（import 指向外部框架，不产生项目内边）', async () => {
    expect(await query.execute({ action: 'defs', symbol: 'swHelper' }))
      .toContain('Definition(s) of "swHelper"');
    const deps = await query.execute({ action: 'deps', file: 'swift/App.swift' });
    expect(deps).toMatch(/has no tracked dependencies/);
  });
});

// =====================================================================
// 图形输出
// =====================================================================

describe('graphviz 文件依赖图', () => {
  let mgr: XrefManager;
  let graph: XrefGraphTool;

  beforeAll(async () => {
    const created = await createIsolatedManager('graphviz');
    mgr = created.mgr;
    graph = new XrefGraphTool(mgr);
    await new XrefBuildTool(mgr).execute({});
  });

  afterAll(() => { try { mgr.close(); } catch { /* ignore */ } });

  it('file 模式在 graphviz 下可用（修复前只处理 symbol，静默输出空图）', async () => {
    const out = await graph.execute({ file: 'src/b.ts', format: 'graphviz', max_depth: 1 });
    expect(out).toContain('```dot');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('->');
    expect(out).not.toContain('No relationships found');
  });

  it('direction 参数生效（callers / callees 分开）', async () => {
    const onlyCallers = await graph.execute({ symbol: 'helperA', format: 'text', direction: 'callers', max_depth: 2 });
    expect(onlyCallers).toContain('▲ Callers');
    expect(onlyCallers).not.toContain('▼ Callees');
  });

  it('mermaid 节点 id 不因路径字符替换而相撞', async () => {
    const out = await graph.execute({ file: 'src/b.ts', format: 'mermaid', max_depth: 2 });
    const ids = [...out.matchAll(/^\s+(n\d+)\[/gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// =====================================================================
// 隔离自检
// =====================================================================

describe('隔离', () => {
  it('所有库都落在被劫持的临时 home 内，未触碰真实 ~/.agent/cache', async () => {
    const cacheDir = path.join(fakeHome, '.agent', 'cache');
    const entries = await fs.readdir(cacheDir);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((f) => f.startsWith('xref-') && f.endsWith('.sqlite'))).toBe(true);
  });
});
