/**
 * SQLite 兼容封装层
 *
 * 用 Node 内置 `node:sqlite`（DatabaseSync）替代 better-sqlite3，
 * 暴露与 better-sqlite3 兼容的 API：
 *   - `new Database(path, { readonly })`
 *   - `db.pragma(str)`（内部转 db.exec("PRAGMA ...")）
 *   - `db.prepare(sql).run/all/get(...)`（返回结构一致：run → {changes, lastInsertRowid}）
 *   - `db.exec(sql)`
 *   - `db.transaction(fn)`（手动 BEGIN/COMMIT/ROLLBACK 包装）
 *   - `db.close()`
 *
 * 收益：Node ≥22.5 自带 SQLite，用户无需安装/编译 better-sqlite3（C++ 原生模块），
 * 知识库/FTS5/xref 在无编译环境下开箱即用。
 *
 * 注意：node:sqlite 目前标记 experimental，但 API 已稳定（Node 24 实测通过）。
 * 若未来 API 变化，只需改本文件，业务代码不受影响。
 */

import { DatabaseSync } from 'node:sqlite';

// ── 类型 ────────────────────────────────────────────────────────────

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

// 与 better-sqlite3（any 风格）保持一致的行类型：
// 返回宽松类型，业务代码原有的 `as Xxx[]` 断言无需改动。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

export interface SqliteDatabase {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(sql: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
  close(): void;
}

// ── 内部：Statement 适配 ────────────────────────────────────────────

class CompatStatement implements Statement {
  constructor(private stmt: ReturnType<DatabaseSync['prepare']>) {}

  run(...params: unknown[]): RunResult {
    const r = this.stmt.run(...params as never[]) as { changes: number; lastInsertRowid: number | bigint };
    return { changes: Number(r.changes ?? 0), lastInsertRowid: r.lastInsertRowid };
  }

  get(...params: unknown[]): Row | undefined {
    return this.stmt.get(...params as never[]) as Row | undefined;
  }

  all(...params: unknown[]): Row[] {
    return this.stmt.all(...params as never[]) as Row[];
  }
}

// ── 内部：Database 适配 ─────────────────────────────────────────────

class CompatDatabase implements SqliteDatabase {
  private db: DatabaseSync;

  constructor(path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) {
    // 只读：readOnly 选项；fileMustExist 仅在建库路径需要存在时用（node:sqlite 默认自动建库，
    // 通过 fileMustExist 模拟 better-sqlite3 的行为差异——但默认保持自动建库，避免行为变化）
    const openOpts: Record<string, unknown> = {};
    if (options?.readonly) openOpts.readOnly = true;
    if (options?.fileMustExist) openOpts.fileMustExist = true;
    this.db = new DatabaseSync(path, openOpts);
  }

  prepare(sql: string): Statement {
    return new CompatStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string): void {
    // better-sqlite3 的 pragma 接收不带 PRAGMA 前缀的参数（如 'journal_mode = WAL'）并自动补全；
    // node:sqlite 无 pragma 方法，这里补全前缀后用 exec 执行。
    // 注意：pragma 查询（如 journal_mode）会打印一行结果，exec 会静默执行。
    const prefixed = /^\s*PRAGMA\s/i.test(sql) ? sql : `PRAGMA ${sql}`;
    this.db.exec(prefixed);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction(fn: (...args: any[]) => any): (...args: any[]) => any {
    // node:sqlite 无 .transaction 助手，手动 BEGIN/COMMIT/ROLLBACK 包装
    const wrapped = (...args: any[]): any => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* rollback 失败忽略 */ }
        throw err;
      }
    };
    return wrapped;
  }

  close(): void {
    this.db.close();
  }
}

// ── 入口 ────────────────────────────────────────────────────────────

export function Database(path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): SqliteDatabase {
  return new CompatDatabase(path, options);
}

export default Database;
