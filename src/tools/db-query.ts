import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';
import Database from './sqlite.js';
import { getToolConfig } from './tool-config.js';

/**
 * DbQueryTool — SQLite 内置支持，参数化查询。
 * 使用 node:sqlite（兼容封装层）进行本地 SQLite 查询，无需编译原生依赖。
 */
export class DbQueryTool implements Tool {
  readonly name = 'db_query';
  readonly description =
    '对 SQLite 数据库执行参数化 SQL 查询。SELECT 返回格式化表格（JSON 对象数组）。INSERT/UPDATE/DELETE 返回影响行数。参数通过 JSON 数组安全传入，杜绝注入风险。支持只读和读写模式。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      database: {
        type: 'string',
        description: 'Path to the SQLite database file (absolute or relative to cwd)',
      },
      query: {
        type: 'string',
        description: 'SQL query to execute. Use ? placeholders for parameters.',
      },
      params: {
        type: 'string',
        description: 'JSON array of parameter values to bind to ? placeholders. Example: [1, "hello"]',
      },
      readonly: {
        type: 'boolean',
        description: 'If true, opens database in read-only mode. Default: false for SELECT, true otherwise.',
      },
    },
    required: ['database', 'query'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const dbPath = args.database as string;
    const query = args.query as string;
    const paramsRaw = args.params as string | undefined;
    const readonlyFlag = args.readonly as boolean | undefined;

    if (!dbPath || !query) return 'Error: database and query are required.';

    const cwd = process.cwd();
    const absDb = path.isAbsolute(dbPath) ? dbPath : path.resolve(cwd, dbPath);

    if (!fs.existsSync(absDb)) {
      return `Error: Database file not found: ${absDb}`;
    }

    // Parse params
    let params: unknown[] = [];
    if (paramsRaw) {
      try {
        params = JSON.parse(paramsRaw);
        if (!Array.isArray(params)) {
          return 'Error: params must be a JSON array.';
        }
      } catch {
        return 'Error: params must be a valid JSON array string.';
      }
    }

    // Determine read-only mode
    const isSelect = /^\s*SELECT|PRAGMA|EXPLAIN/i.test(query.trim());
    const readOnly = readonlyFlag ?? isSelect;

    const db = Database(absDb, { readonly: readOnly });
    try {
      const isQuery = /^\s*SELECT|PRAGMA|EXPLAIN|WITH\s/i.test(query.trim());

      if (isQuery) {
        const stmt = db.prepare(query);
        const rows = params.length > 0 ? stmt.all(...params) : stmt.all();

        if (rows.length === 0) return '(empty result set)';

        // Format as a Markdown table for readability
        const columns = Object.keys(rows[0] as object);
        const header = '| ' + columns.join(' | ') + ' |';
        const separator = '|' + columns.map(() => '---').join('|') + '|';
        const bodyRows = (rows as Record<string, unknown>[]).map(row =>
          '| ' + columns.map(c => String(row[c] ?? 'NULL')).join(' | ') + ' |',
        );

        const maxRows = getToolConfig('db.maxRows', 200); // tools.db.maxRows
        const result = [header, separator, ...bodyRows.slice(0, maxRows)].join('\n');
        const suffix = rows.length > maxRows
          ? `\n\n... (${rows.length - maxRows} more rows, ${rows.length} total)`
          : `\n\n${rows.length} row(s)`;

        return result + suffix;
      } else {
        const stmt = db.prepare(query);
        const result = params.length > 0 ? stmt.run(...params) : stmt.run();
        return `Query OK. ${result.changes} row(s) affected.`;
      }
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    } finally {
      db.close();
    }
  }
}
