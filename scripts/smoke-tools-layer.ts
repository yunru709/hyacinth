/**
 * 冒烟：工具层适配验证（db_query 直接调用 + kb_structured 工具 + xref 工具注入）
 * 验证暴露给用户的 SQLite 工具都走封装层、无 better-sqlite3 依赖
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DbQueryTool } from '../src/tools/db-query.js';
import { createStructuredTool } from '../src/knowledge/structured-tools.js';
import { StructuredStore } from '../src/knowledge/structured-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-tools-'));
const dbPath = path.join(tmp, 'test.db');
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

// ── 1. db_query 工具（唯一直接操作 SQLite 的工具）──
console.log('\n[1] db_query 工具');
{
  // 先建库
  const db = (await import('../src/tools/sqlite.js')).default(dbPath);
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO users(name) VALUES (?)').run('alice');
  db.prepare('INSERT INTO users(name) VALUES (?)').run('bob');
  db.close();

  const tool = new DbQueryTool();
  const res = await tool.execute({ database: dbPath, query: 'SELECT * FROM users' });
  check('SELECT 返回表', typeof res === 'string' && res.includes('alice') && res.includes('bob'), String(res).slice(0, 100));
  const res2 = await tool.execute({ database: dbPath, query: 'UPDATE users SET name = ? WHERE id = ?', params: '["carol", 1]' });
  check('UPDATE 返回行数', typeof res2 === 'string' && res2.includes('1 row'), String(res2));
  const res3 = await tool.execute({ database: dbPath, query: 'SELECT COUNT(*) AS c FROM users' });
  check('COUNT 查询', typeof res3 === 'string' && res3.includes('2'));
  // 只读拦截
  const res4 = await tool.execute({ database: dbPath, query: 'DELETE FROM users', readonly: true });
  check('只读拦截', typeof res4 === 'string' && res4.includes('Error'), String(res4));
}

// ── 2. kb_structured 工具（注入 StructuredStore）──
console.log('\n[2] kb_structured 工具');
{
  const store = new StructuredStore(path.join(tmp, 'kb.sqlite'));
  const tool = createStructuredTool(() => store, () => true);
  const add = await tool.execute({ action: 'add', entries: [
    { id: 't1', title: '测试条目', tags: ['test', 'smoke'], category: 'reference', content: '工具层适配验证' },
  ] });
  check('add 返回成功', typeof add === 'string' && !add.includes('Error'), String(add).slice(0, 80));
  const list = await tool.execute({ action: 'list' });
  check('list 返回条目', typeof list === 'string' && list.includes('t1'), String(list).slice(0, 100));
  const del = await tool.execute({ action: 'delete', id: 't1' });
  check('delete 成功', typeof del === 'string' && !del.includes('Error'), String(del).slice(0, 80));
  store.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
