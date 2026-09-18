/**
 * xref-confidence.test.ts — Phase 3：置信度标注（消费 files.parser 列）
 *
 * 为什么需要：索引数据有两档精度来源 —— 语法树/AST（precise）与正则兜底（heuristic）。
 * 模型看结果是**字面思维**，不确定性必须显式写进输出；否则它会拿正则级结论当精确事实用。
 * 判据（都对着真实产出，不看文档）：
 *  ① .ts（ts-ast）/ .py（py-tree-sitter）/ .go（go-tree-sitter）→ [precise]；
 *     .rs（generic-regex）→ [heuristic] —— Go 升级到语义链后，heuristic 档改用**尚未铺到**的 Rust 作代表
 *  ② 块级标注：deps 整块由被查文件产出 → 标在表头
 *  ③ 图例：出现标注时必须附一行说明标签含义；没有标注时不得凭空出现
 *
 * 隔离：沿用同目录惯例（劫持 os.homedir()）。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from './manager.js';
import { XrefQueryTool } from './xref-query.js';
import { XrefGraphTool } from './xref-graph.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

const PROJECT = {
  'src/a.ts': [
    "import { helperB } from './b';",
    '',
    'export function main(): number {',
    '  return helperB();',
    '}',
    '',
  ].join('\n'),
  'src/b.ts': 'export function helperB(): number {\n  return 1;\n}\n',
  'src/c.py': 'def gamma():\n    return 1\n',
  'src/d.rs': 'fn delta() -> i32 {\n    1\n}\n',
};

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-conf-'));
  for (const [rel, content] of Object.entries(PROJECT)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
  }
  return root;
}

describe('Phase 3：置信度标注', () => {
  let root: string;
  let m: XrefManager;
  let query: XrefQueryTool;

  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-conf-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    root = await makeProject();
    m = new XrefManager();
    await m.init(root);
    await m.build(undefined, undefined, 50, { force: true });
    query = new XrefQueryTool(m);
  });

  afterAll(async () => {
    m?.close();
    await fs.rm(root, { recursive: true, force: true });
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome);
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('① 语义链语言（ts/py/go）→ [precise]；仍走正则的（rs）→ [heuristic]', async () => {
    const ts = await query.execute({ action: 'defs', symbol: 'main' });
    expect(ts).toContain('[precise]');

    const py = await query.execute({ action: 'defs', symbol: 'gamma' });
    expect(py).toContain('[precise]'); // Phase 2 之后 .py 走语法树

    const go = await query.execute({ action: 'defs', symbol: 'delta' });
    // 只能对**数据行**断言：图例要解释两个标签，所以整段输出必然同时含 [precise]。
    // （首版就是错在这里 —— 对整段断言 "不含 [precise]" 永远失败，是测试写错而非代码错。）
    const goRow = go.split('\n').find((l) => l.includes('src/d.rs'));
    expect(goRow, 'delta 的定义行应存在').toBeTruthy();
    expect(goRow).toContain('[heuristic]');
    expect(goRow).not.toContain('[precise]');
  });

  it('② 块级标注：deps 整块由被查文件产出 → 标在表头', async () => {
    const deps = await query.execute({ action: 'deps', file: 'src/a.ts' });
    // 表头形如 `src/a.ts depends on (1): [precise]`
    const header = deps.split('\n')[0];
    expect(header).toContain('depends on');
    expect(header).toContain('[precise]');
  });

  it('② 逐行标注：dependents 标在产出该边的文件上', async () => {
    const dep = await query.execute({ action: 'dependents', file: 'src/b.ts' });
    const row = dep.split('\n').find((l) => l.includes('src/a.ts'));
    expect(row, 'a.ts 依赖 b.ts 这一行应存在').toBeTruthy();
    expect(row).toContain('[precise]'); // 边由 a.ts 的解析产出，而 a.ts 是 ts-ast
  });

  it('③ 图例：出现标注时附一行说明；两个标签的含义都写明', async () => {
    const out = await query.execute({ action: 'defs', symbol: 'delta' });
    expect(out).toContain('[heuristic] = 正则兜底');
    expect(out).toContain('[precise] = 出自语法树/AST');
  });

  it('③ 未识别符号 → 无标注也无图例（不凭空出现）', async () => {
    const out = await query.execute({ action: 'defs', symbol: 'no_such_symbol_xyz' });
    expect(out).not.toContain('[precise]');
    expect(out).not.toContain('[heuristic]');
    expect(out).not.toContain('标注：');
  });

  it('graph 的文件依赖图表头同样带标注（query 与 graph 两个出口都覆盖）', async () => {
    const g = await new XrefGraphTool(m).execute({ format: 'text', file: 'src/a.ts', max_depth: 1 });
    expect(g).toContain('[precise]'); // 被查文件（a.ts = ts-ast）的产出精度
    expect(g).toContain('标注：'); // 图例由 query()/graph() 共用出口统一追加
  });
});
