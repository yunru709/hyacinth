#!/usr/bin/env node
/**
 * smoke-xref-repo.mjs —— 真实仓库冒烟（任务单第三条：非夹具，每门语言落地后必做）
 *
 * 夹具覆盖不到 decorator / async / 泛型 / 宏等真实形状，故铺量中途必须实测。
 * 本脚本对**任意真实项目**跑一次索引并检查三样：
 *   ① parser_breakdown 中语法树档（*-tree-sitter / *-ast）的占比
 *   ② 未解析导入（unresolved_imports）是否异常 —— 并列出样例人工过目
 *   ③ callers 是否合理 —— 自动挑"被引用最多"的符号查一次，看能否列出调用者
 * 用法：node scripts/smoke-xref-repo.mjs <项目路径>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XrefManager } from '../dist/tools/xref/manager.js';
import { XrefQueryTool } from '../dist/tools/xref/xref-query.js';
// 项目是 ESM：用动态 import 取工具函数（不要 require，避免 CJS/ESM 互操作的暗坑）
const { toProjectKey } = await import('../dist/utils/misc.js');

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error('用法：node scripts/smoke-xref-repo.mjs <项目路径>');
  process.exit(2);
}
const root = path.resolve(target);

console.log(`══ 冒烟：${root} ══`);
const m = new XrefManager();
await m.init(root);
const stats = await m.build(undefined, undefined, 50, { force: true });

console.log('\n── ① 规模与出处 ──');
console.log(`  files=${stats.files} symbols=${stats.symbols} refs=${stats.refs} imports=${stats.imports}`);
console.log(`  duration=${stats.duration_ms}ms parsed=${stats.parsed_files} unchanged=${stats.unchanged_files} failed=${stats.failed_files}`);
const pb = stats.parser_breakdown ?? {};
const total = Object.values(pb).reduce((a, b) => a + b, 0) || 1;
for (const [k, v] of Object.entries(pb).sort((a, b) => b[1] - a[1])) {
  const tier = k.includes('ast') || k.includes('tree-sitter') ? '语义档' : '正则档';
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}  ${((v / total) * 100).toFixed(1)}%  [${tier}]`);
}

console.log('\n── ② 导入解析健康度 ──');
console.log(`  未解析（项目内、应入图却失败）= ${stats.unresolved_imports ?? 0}`);
console.log(`  外部依赖（设计上不入图）        = ${stats.external_imports ?? 0}`);
for (const s of (stats.unresolved_samples ?? []).slice(0, 8)) console.log(`    · ${s}`);

console.log('\n── ③ callers 合理性（自动挑被引用最多的符号）──');
const dbPath = path.join(os.homedir(), '.agent', 'cache', `xref-${toProjectKey(root)}.sqlite`);
const { DatabaseSync } = await import('node:sqlite');
let topSymbol = null;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // 只挑**在索引里有定义**的符号：否则会挑到 `get` 这类遍地重名的内建方法，
  // 输出退化成"仅同名 200 条"，冒烟就看不出 callers 是否真的可用（首次实测即踩到）。
  const row = db
    .prepare(
      `SELECT r.symbol_name, COUNT(*) c
         FROM refs r JOIN symbols s ON s.name = r.symbol_name
        WHERE r.kind = ? AND s.kind IN ('function','method','class')
        GROUP BY r.symbol_name
        ORDER BY c DESC LIMIT 1`,
    )
    .get('call');
  db.close();
  topSymbol = row?.symbol_name ?? null;
} catch (err) {
  console.log(`  （读库失败：${err.message}）`);
}
if (topSymbol) {
  const out = await new XrefQueryTool(m).execute({ action: 'callers', symbol: topSymbol });
  const lines = out.split('\n');
  const body = lines.filter((l) => l.trim().startsWith('') && l.includes(':')).slice(0, 5);
  console.log(`  符号 "${topSymbol}" 的 callers 输出前几行：`);
  for (const l of lines.slice(0, 8)) console.log(`    ${l}`);
  console.log(`  → 带 [precise] 的调用者行数：${lines.filter((l) => l.includes('[precise]')).length}`);
  console.log(`  → 带 caller_name 的（含 "(in "）行数：${lines.filter((l) => l.includes('(in ')).length}`);
  void body;
} else {
  console.log('  （库中没有调用引用 —— 可能该语言尚未接引用提取）');
}
m.close();
console.log(`\n索引库：${dbPath}`);
console.log(`库大小：${(fs.existsSync(dbPath) ? fs.statSync(dbPath).size / 1024 / 1024 : 0).toFixed(2)} MB`);
