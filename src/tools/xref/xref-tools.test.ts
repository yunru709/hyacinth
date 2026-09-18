/**
 * xref-tools.test.ts —— 交叉引用三工具（xref_build / xref_query / xref_graph）行为测试
 *
 * 此前覆盖：`src/plugins/xref-plugin.test.ts` 仅 2 例（mount 注册 3 个工具 + 卸载回滚），
 * 工具本体的执行逻辑零覆盖。本文件补上行为级测试。
 *
 * 本文件同时承担「修复验证」：下列缺陷已修复，对应用例从 it.fails 转为正向断言 ——
 *   1. deps/dependents 把 JSON 字符串当数组 join → TypeError（已修：parseSymbols）
 *   2. 扫描路径 `\` 与查询路径 `/` 不一致 → 重复登记 + File not in index
 *      （已修：normPath 单一规范 + 两阶段入库，避免 REPLACE 换 id 触发级联删除）
 *   3. deleteDatabase 同步签名却对 promise 版 fs 不 await（已修：async + await fs.rm force）
 *   4. format:"json" 空承诺（已修：从 schema/描述/类型中移除）
 *   5. trace 对同文件局部变量无结果（已修：按声明节点而非名字过滤）
 *   6. 增量传相对路径不生效（已修：按项目根解析 + 规范化）
 *   7. ESM `./x.js` 说明符解析不到 → imports 恒为 0（已修：原路径 + .js→.ts 回退，
 *      见 xref-resolve.test.ts；本文件原「已知能力边界」用例已转为正向断言）
 *   8. 每次构建都清库重建（已修：mtime 驱动的 sync 构建 + force 全量）
 *
 * 说明符解析 / 桶文件透传 / 同步构建 / 调用图限定域 / 多语言 的专项测试
 * 见同目录 `xref-resolve.test.ts`。
 *
 * ## 隔离（关键：xref 的库位置没有环境变量开关）
 * `XrefManager.init()` 把库固定写在 `~/.agent/cache/xref-<projectKey>.sqlite`，
 * 全仓无 `HYACINTH_XREF_*` 覆盖点 —— 不像 sessions 有 `HYACINTH_SESSIONS_ROOT`。
 * 因此本文件**劫持 `os.homedir()` 指向临时目录**，并在 `init()` 之后立刻断言
 * `dbPath` 落在该临时目录内；一旦劫持失效就抛错中止，绝不让它落到真实 ~/.agent/cache。
 *
 * 隔离约定：fixture 全部在 os.tmpdir() 下、块末清理、不触碰项目目录。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { XrefManager } from './manager.js';
import { XrefBuildTool } from './xref-build.js';
import { XrefQueryTool } from './xref-query.js';
import { XrefGraphTool } from './xref-graph.js';

// ─── 夹具 ──────────────────────────────────────────────────────────────

let tmpRoot: string;
let fakeHome: string;
let realHome: string;
let projectRoot: string;
let manager: XrefManager;
let buildTool: XrefBuildTool;
let queryTool: XrefQueryTool;
let graphTool: XrefGraphTool;
let homedirSpy: ReturnType<typeof vi.spyOn>;

const FIXTURES: Record<string, string> = {
  // 被依赖方：helperB 调用 helperA（callers / callees / refs 用）
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

  // 依赖方：无扩展名相对导入（xref 能解析的形态）
  'src/a.ts': [
    "import { helperB } from './b';",
    '',
    'export function main(): number {',
    '  const r = helperB();',
    '  return r;',
    '}',
    '',
  ].join('\n'),

  // 继承关系（hierarchy 用）
  'src/derived.ts': [
    'export class Base {',
    '  ping(): string {',
    "    return 'p';",
    '  }',
    '}',
    '',
    'export class Derived extends Base {',
    '  run(): string {',
    '    return this.ping();',
    '  }',
    '}',
    '',
  ].join('\n'),

  // 同文件局部变量的赋值/自增（trace 用）
  'src/obj.ts': [
    'export function counter(): number {',
    '  let total = 0;',
    '  total = total + 1;',
    '  total += 2;',
    '  return total;',
    '}',
    '',
  ].join('\n'),

  // ESM 风格 .js 说明符（本项目自身即此风格）——用于固定"解析不了"这一能力边界
  'src/esm.ts': [
    "import { helperA } from './b.js';",
    '',
    'export function esmUser(): number {',
    '  return helperA();',
    '}',
    '',
  ].join('\n'),

  // 根目录文件：验证 directories 过滤生效
  'root-only.ts': ['export function rootOnly(): number {', '  return 0;', '}', ''].join('\n'),
};

async function writeFixtures(root: string): Promise<void> {
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  }
}

/** 建一个隔离的 manager（临时 home + 临时项目）；隔离校验不通过即抛错中止 */
async function createIsolatedManager(tag: string): Promise<{ mgr: XrefManager; dbPath: string; root: string }> {
  const root = path.join(tmpRoot, `proj-${tag}`);
  await fs.mkdir(root, { recursive: true });
  await writeFixtures(root);

  const mgr = new XrefManager();
  await mgr.init(root);

  const dbPath = (mgr as unknown as { dbPath: string }).dbPath;
  if (!norm(dbPath).startsWith(norm(fakeHome))) {
    throw new Error(`[隔离失败] xref 库落在 ${dbPath}，不在临时 home 内 —— 中止以免污染真实 ~/.agent`);
  }
  return { mgr, dbPath, root };
}

const norm = (p: string) => p.replace(/\\/g, '/');

beforeAll(async () => {
  tmpRoot = path.join(os.tmpdir(), `hyacinth-xref-test-${crypto.randomUUID()}`);
  fakeHome = path.join(tmpRoot, 'home');
  projectRoot = path.join(tmpRoot, 'project');
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });

  // 劫持 homedir：xref 库位置唯一的隔离手段（生产代码无 env 覆盖点）
  realHome = os.homedir(); // 先留真值，供隔离自检比对
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

  await writeFixtures(projectRoot);
  manager = new XrefManager();
  await manager.init(projectRoot);

  const dbPath = (manager as unknown as { dbPath: string }).dbPath;
  if (!norm(dbPath).startsWith(norm(fakeHome))) {
    throw new Error(`[隔离失败] xref 库落在 ${dbPath} —— 中止以免污染真实 ~/.agent`);
  }

  buildTool = new XrefBuildTool(manager);
  queryTool = new XrefQueryTool(manager);
  graphTool = new XrefGraphTool(manager);

  await buildTool.execute({});
});

afterAll(async () => {
  try { manager?.close(); } catch { /* ignore */ }
  homedirSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

// =====================================================================
// xref_build
// =====================================================================

describe('xref_build', () => {
  it('全量构建返回文件/符号/引用/导入统计，并记录 built_at', async () => {
    const stats = manager.getStats()!;
    expect(stats.files).toBe(6); // src 下 5 个 + root-only.ts，无重复行
    expect(stats.symbols).toBeGreaterThan(0);
    expect(stats.built_at).toBeTruthy();

    const again = await buildTool.execute({});
    expect(again).toContain('Cross-reference index built successfully (sync (mtime-based))');
    expect(again).toMatch(/Files indexed:\s+\d+/);
    expect(again).toMatch(/Symbols found:\s+\d+/);
    // 第二次构建全部命中 mtime 未变 → 跳过解析，但统计必须仍反映索引总量
    expect(again).toMatch(/Unchanged:\s+6\b/);
    expect(again).toMatch(/Parsed now:\s+0\b/);
    expect(again).not.toMatch(/Import edges:\s+0\b/);
  });

  it('未初始化的 manager 报错（isReady=false）', async () => {
    const fresh = new XrefBuildTool(new XrefManager());
    expect(await fresh.execute({})).toContain('XrefManager not initialized');
  });

  it('directories 参数：非法 JSON / 非数组分别报错', async () => {
    expect(await buildTool.execute({ directories: 'not-json' }))
      .toContain('must be a valid JSON array string');
    expect(await buildTool.execute({ directories: '{"a":1}' }))
      .toContain('must be a JSON array of directory paths');
  });

  it('files 参数：非法 JSON / 非数组分别报错', async () => {
    expect(await buildTool.execute({ files: 'not-json' }))
      .toContain('must be a valid JSON array string');
    expect(await buildTool.execute({ files: '"str"' }))
      .toContain('must be a JSON array of file paths');
  });
});

describe('xref_build（独立库：目录过滤 / 增量 / 清理）', () => {
  it('directories 限制扫描范围：范围外文件不进索引，文件数无重复', async () => {
    const { mgr } = await createIsolatedManager('dirs');
    try {
      const tool = new XrefBuildTool(mgr);
      const query = new XrefQueryTool(mgr);

      const filtered = await tool.execute({ directories: '["src"]' });
      expect(filtered).toContain('sync, filtered (1 dirs: src)');
      // src 下恰好 5 个 .ts；修复前因路径双形态会多出 1 行（=6）
      expect(mgr.getStats()!.files).toBe(5);

      expect(await query.execute({ action: 'defs', symbol: 'rootOnly' }))
        .toContain('No definition of');
      expect(await query.execute({ action: 'defs', symbol: 'helperA' }))
        .toContain('Definition(s) of "helperA"');

      await tool.execute({});
      expect(await query.execute({ action: 'defs', symbol: 'rootOnly' }))
        .toContain('Definition(s) of "rootOnly"');
    } finally { mgr.close(); }
  });

  it('增量更新：绝对路径只重建该文件', async () => {
    const { mgr, root } = await createIsolatedManager('incremental');
    try {
      const result = await new XrefBuildTool(mgr).execute({
        files: JSON.stringify([path.join(root, 'src', 'b.ts')]),
      });
      expect(result).toContain('incremental (1 files)');
      expect(result).toContain('Files indexed:   1');
    } finally { mgr.close(); }
  });

  it('增量更新：相对路径按项目根解析（修复前静默 0 文件）', async () => {
    const { mgr } = await createIsolatedManager('incremental-rel');
    try {
      const result = await new XrefBuildTool(mgr).execute({ files: '["src/b.ts"]' });
      expect(result).toContain('incremental (1 files)');
      expect(result).toContain('Files indexed:   1');

      // 重建后索引仍可用（相对路径没有把行搞乱）
      expect(await new XrefQueryTool(mgr).execute({ action: 'defs', symbol: 'helperB' }))
        .toContain('Definition(s) of "helperB"');
    } finally { mgr.close(); }
  });

  it('clean=true：删除已完成再返回（三件套真被删掉，非"发射即忘"）', async () => {
    const { mgr, dbPath } = await createIsolatedManager('clean');
    try {
      const result = await new XrefBuildTool(mgr).execute({ clean: true });
      expect(result).toBe(`✅ Xref database deleted: ${dbPath}`);

      // 关键：await 之后文件必须已经不在了
      expect(fss.existsSync(dbPath)).toBe(false);
      expect(norm(dbPath).startsWith(norm(fakeHome))).toBe(true);

      expect(mgr.isReady()).toBe(false);
      expect(await new XrefQueryTool(mgr).execute({ action: 'defs', symbol: 'helperA' }))
        .toContain('Xref index not built');
    } finally { mgr.close(); }
  });

  it('clean 指定不存在的项目 → 返回"未找到"（修复后可确定性走到该分支）', async () => {
    const { mgr } = await createIsolatedManager('clean-missing');
    try {
      const result = await new XrefBuildTool(mgr).execute({ clean: true, project: 'no-such-project-key-xyz' });
      expect(result).toBe(
        `Database not found or already deleted: ${path.join(fakeHome, '.agent', 'cache', 'xref-no-such-project-key-xyz.sqlite')}`,
      );
    } finally { mgr.close(); }
  });

  it('clean 支持绝对路径入参 → 映射到该项目的库', async () => {
    const { mgr, root } = await createIsolatedManager('clean-abs');
    try {
      const result = await new XrefBuildTool(mgr).execute({ clean: true, project: root });
      expect(norm(result)).toContain(norm(path.join(fakeHome, '.agent', 'cache')));
      expect(norm(result)).toContain('xref-');
    } finally { mgr.close(); }
  });
});

// =====================================================================
// xref_query
// =====================================================================

describe('xref_query', () => {
  it('未构建时返回引导错误（未初始化 manager）', async () => {
    const fresh = new XrefQueryTool(new XrefManager());
    expect(await fresh.execute({ action: 'defs', symbol: 'x' }))
      .toContain('Xref index not built');
  });

  it('action 必须受支持，缺参数分别报错', async () => {
    expect(await queryTool.execute({ action: 'nope' })).toContain('Unknown action');
    expect(await queryTool.execute({ action: 'refs' })).toContain('"symbol" is required');
    expect(await queryTool.execute({ action: 'deps' })).toContain('"file" is required');
  });

  it('schema 不再声明 format（原 json 是空承诺，已移除）', () => {
    const props = (queryTool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).not.toContain('format');
  });

  it('defs：返回定义位置与签名（含 exported 标记）', async () => {
    const result = await queryTool.execute({ action: 'defs', symbol: 'helperA' });
    expect(result).toContain('Definition(s) of "helperA"');
    expect(result).toContain('[function]');
    expect(result).toContain('exported');
    expect(result).toContain('b.ts');
  });

  it('defs + kind 过滤（同名不同 kind）', async () => {
    expect(await queryTool.execute({ action: 'defs', symbol: 'Base', kind: 'class' }))
      .toContain('[class]');
    // kind 过滤把结果清空 ≠ 符号不存在：要说清已存在哪些 kind（SQL 侧过滤后需主动补这句）
    const wrongKind = await queryTool.execute({ action: 'defs', symbol: 'Base', kind: 'function' });
    expect(wrongKind).toContain('No definition of "Base" with kind "function"');
    expect(wrongKind).toContain('Existing kinds: class');
  });

  it('defs：不存在的符号返回提示', async () => {
    expect(await queryTool.execute({ action: 'defs', symbol: 'no_such_symbol_xyz' }))
      .toContain('No definition of');
  });

  it('refs：列出符号的所有引用（含 kind 与文件:行）', async () => {
    const result = await queryTool.execute({ action: 'refs', symbol: 'helperA' });
    expect(result).toContain('References to "helperA"');
    expect(result).toContain('b.ts:');
  });

  it('refs：无引用符号返回提示', async () => {
    expect(await queryTool.execute({ action: 'refs', symbol: 'no_such_symbol_xyz' }))
      .toContain('No references to');
  });

  it('callers：谁调用了 helperA（含 caller_name）', async () => {
    const result = await queryTool.execute({ action: 'callers', symbol: 'helperA' });
    expect(result).toContain('Callers of "helperA"');
    expect(result).toContain('(in helperB)');
  });

  it('callees：main → helperB，depth=2 继续下探到 helperA', async () => {
    const depth1 = await queryTool.execute({ action: 'callees', symbol: 'main' });
    expect(depth1).toContain('Callees of "main"');
    expect(depth1).toContain('helperB');
    expect(depth1).not.toContain('helperA');

    const depth2 = await queryTool.execute({ action: 'callees', symbol: 'main', depth: 2 });
    expect(depth2).toContain('helperB');
    expect(depth2).toContain('helperA');
  });

  it('callees：无下探时给出说明', async () => {
    expect(await queryTool.execute({ action: 'callees', symbol: 'helperA' }))
      .toContain('No callees found for "helperA"');
  });

  it('symbol_search：哪些文件导入了指定符号', async () => {
    const result = await queryTool.execute({ action: 'symbol_search', symbol: 'helperB' });
    expect(result).toContain('Files importing "helperB"');
    expect(result).toContain('[static]');
  });

  it('dependents：哪些文件导入了 b.ts（修复前此处 TypeError 崩溃）', async () => {
    const result = await queryTool.execute({ action: 'dependents', file: 'src/b.ts' });
    expect(result).toContain('Files depending on src/b.ts');
    expect(result).toContain('a.ts');
    expect(result).toContain('{helperB}');
  });

  it('deps：a.ts 依赖 b.ts（含导入符号；修复前 Windows 报 File not in index）', async () => {
    const result = await queryTool.execute({ action: 'deps', file: 'src/a.ts' });
    expect(result).toContain('src/a.ts depends on');
    expect(result).toContain('b.ts');
    expect(result).toContain('{helperB}');
  });

  it('hierarchy：Base 无父类、有一个子类 Derived', async () => {
    const base = await queryTool.execute({ action: 'hierarchy', symbol: 'Base' });
    expect(base).toContain('Hierarchy for class "Base"');
    expect(base).toContain('Parents: (none — root class)');
    expect(base).toContain('Derived');

    const derived = await queryTool.execute({ action: 'hierarchy', symbol: 'Derived' });
    expect(derived).toContain('- Base');
  });

  it('hierarchy：非类符号返回提示', async () => {
    expect(await queryTool.execute({ action: 'hierarchy', symbol: 'helperA' }))
      .toContain('not found in index');
  });

  it('impact：改 b.ts 影响 a.ts（BFS 分层）', async () => {
    const result = await queryTool.execute({ action: 'impact', file: 'src/b.ts', depth: 2 });
    expect(result).toContain('Impact of changing src/b.ts');
    expect(result).toContain('Layer 1');
    expect(result).toContain('a.ts');
    expect(result).toMatch(/Total:\s+\d+ files across \d+ layers/);
  });

  it('trace：导入符号在文件内的数据流点被记录', async () => {
    const result = await queryTool.execute({ action: 'trace', symbol: 'helperB', file: 'src/a.ts' });
    expect(result).toContain('Data flow for "helperB" in src/a.ts');
    expect(result).toContain('call');
  });

  it('trace：同文件局部变量的 write/read 被记录（修复前恒为空）', async () => {
    const result = await queryTool.execute({ action: 'trace', symbol: 'total', file: 'src/obj.ts' });
    expect(result).toContain('Data flow for "total" in src/obj.ts');
    expect(result).toContain('write');
    expect(result).toContain('read');
  });

  it('ESM 风格 "./b.js" 说明符解析到 src/b.ts（修复前该导入一条都进不了图）', async () => {
    // 本项目自身源码全是这种写法：说明符写 ./x.js、源码实际是 ./x.ts。
    // 修复前 imports 表恒为 0，deps/dependents/impact/symbol_search 全部空转。
    const deps = await queryTool.execute({ action: 'deps', file: 'src/esm.ts' });
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('{helperA}');

    const search = await queryTool.execute({ action: 'symbol_search', symbol: 'helperA' });
    expect(search).toContain('esm.ts →');
  });
});

// =====================================================================
// xref_graph
// =====================================================================

describe('xref_graph', () => {
  it('symbol + mermaid（默认格式）输出可渲染的 mermaid 代码块', async () => {
    const result = await graphTool.execute({ symbol: 'helperB' });
    expect(result.startsWith('```mermaid')).toBe(true);
    expect(result).toContain('graph LR');
    expect(result).toContain('-->|calls|');
    expect(result.trimEnd().endsWith('```')).toBe(true);
  });

  it('symbol + text：输出调用者/被调用者两棵树', async () => {
    const result = await graphTool.execute({ symbol: 'helperA', format: 'text' });
    expect(result).toContain('Call graph for "helperA"');
    expect(result).toContain('▲ Callers (who calls this):');
    expect(result).toContain('▼ Callees (this calls):');
    expect(result).toContain('helperB');
  });

  it('direction=callers 只输出上溯一侧', async () => {
    const result = await graphTool.execute({ symbol: 'helperA', format: 'text', direction: 'callers' });
    expect(result).toContain('▲ Callers');
    expect(result).not.toContain('▼ Callees');
  });

  it('symbol + graphviz：输出 DOT 代码块', async () => {
    const result = await graphTool.execute({ symbol: 'helperA', format: 'graphviz' });
    expect(result).toContain('```dot');
    expect(result).toContain('digraph G {');
    expect(result).toContain('->');
  });

  it('file + text：输出文件依赖树', async () => {
    const result = await graphTool.execute({ file: 'src/b.ts', format: 'text' });
    expect(result).toContain('Dependency graph for src/b.ts');
    expect(result).toContain('a.ts');
  });

  it('无关系的符号 → mermaid 输出占位节点而非空图', async () => {
    const result = await graphTool.execute({ symbol: 'no_such_symbol_xyz' });
    expect(result).toContain('empty[No relationships found]');
  });

  it('缺 symbol/file、未知 format、未构建分别报错', async () => {
    expect(await graphTool.execute({})).toContain('at least one of "symbol" or "file"');
    expect(await graphTool.execute({ symbol: 'x', format: 'svg' })).toContain('Unknown format');
    expect(await new XrefGraphTool(new XrefManager()).execute({ symbol: 'x' }))
      .toContain('Xref index not built');
  });
});

// =====================================================================
// 隔离自检
// =====================================================================

describe('隔离自检', () => {
  it('所有 xref 库都写在被劫持的临时 home 内，未触碰真实 ~/.agent', async () => {
    const cacheDir = path.join(fakeHome, '.agent', 'cache');
    const entries = await fs.readdir(cacheDir);
    expect(entries.length).toBeGreaterThan(0);
    // 允许 -wal / -shm 伴生文件（WAL 模式下开关库时存在）
    expect(entries.every((f) => f.startsWith('xref-') && f.includes('.sqlite'))).toBe(true);
    // 隔离自检的真正断言：本次用到的假 home 与真实 home 不同源
    expect(norm(fakeHome)).not.toBe(norm(realHome));
    expect(norm(realHome)).not.toContain('hyacinth-xref-test-');
  });
});
