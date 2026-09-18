/**
 * python-bridge/parser.test.ts — 回归点
 *
 * 背景（2026-09-19 审计牵出）：`office` 工具包里声明的 `xlsx_read` **一直没被注册**，
 * 日志里刷了 247 次 "does not export a valid Tool"。根因在 docstring 提取：
 *
 *     content.match(/"""([^"]*)"""/s)      ← 字符类**排除双引号**
 *
 * 于是 docstring 里只要出现一个 `"`（xlsx_read.py 的描述里写了 `e.g. "A1:D100"`），
 * 整段匹配就失败 → docstring=null → 该 .py **静默不注册**。
 * 而同胞 docx_read.py 所有值恰好一个引号都没有，所以正常 —— 这正是"一个能装一个装不上"
 * 的全部原因。已改为非贪婪匹配 /"""([\s\S]*?)"""/ 。
 *
 * 本文件锁两件事：
 *   ① 带引号的 docstring 仍能解析（防回归）
 *   ② **真实的内置 .py 必须都能解析出 name 与完整 schema**（防再出现"声明了却装不上"）
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePythonToolMeta } from './parser.js';

const BUILTIN = path.resolve(__dirname, '..', 'builtin');

function tmpPy(docstring: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pytool-'));
  const p = path.join(dir, 't.py');
  fs.writeFileSync(p, `${docstring}\nimport sys\nprint('hi')\n`, 'utf8');
  return p;
}

describe('parsePythonToolMeta', () => {
  it('⚠️ 回归：docstring 里含双引号时仍能解析（曾因此让工具静默消失）', () => {
    const p = tmpPy(`"""
name: quoted_tool
description: Reads a range, e.g. "A1:D100", and returns rows.
parameters:
  type: object
  properties:
    file: {type: string, description: Path to file}
  required: [file]
"""`);
    const meta = parsePythonToolMeta(p);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe('quoted_tool');
    expect(meta!.description).toContain('A1:D100');
  });

  it('无 docstring → null（不误判为合法工具）', () => {
    const p = tmpPy('import sys\nprint(1)');
    expect(parsePythonToolMeta(p)).toBeNull();
  });

  it('缺 name/description → null', () => {
    const p = tmpPy('"""\nparameters:\n  type: object\n"""');
    expect(parsePythonToolMeta(p)).toBeNull();
  });

  it('真实内置 .py 全部可解析，且 schema 完整（防"声明了却装不上"）', () => {
    const files = fs.readdirSync(BUILTIN).filter((f) => f.endsWith('.py'));
    expect(files.length).toBeGreaterThanOrEqual(2); // 别静默退化成空集

    const bad: string[] = [];
    for (const f of files) {
      const meta = parsePythonToolMeta(path.join(BUILTIN, f));
      const stem = f.replace(/\.py$/, '');
      if (!meta) { bad.push(`${f}: 解析为 null（将被静默跳过、永不注册）`); continue; }
      if (meta.name !== stem) bad.push(`${f}: name='${meta.name}' 与文件名不一致`);
      const props = (meta.inputSchema as { properties?: Record<string, unknown> }).properties;
      if (!props || Object.keys(props).length === 0) bad.push(`${f}: inputSchema.properties 为空`);
    }
    expect(bad, `内置 Python 工具元数据有问题：\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('xlsx_read.py：文件名/name/必需参数三项对齐', () => {
    const meta = parsePythonToolMeta(path.join(BUILTIN, 'xlsx_read.py'));
    expect(meta?.name).toBe('xlsx_read');
    const schema = meta!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toContain('file');
    expect(schema.required ?? []).toContain('file');
  });
});
