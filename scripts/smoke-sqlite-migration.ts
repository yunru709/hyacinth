/**
 * 冒烟测试：node:sqlite 迁移后各模块功能验证（回归用）
 * 覆盖：封装层 sqlite.ts / Fts5Retriever / StructuredStore / 只读模式
 *
 * 注意：
 * - Fts5Retriever.search 返回 {title, source, snippet}，不含 id
 * - StructuredStore.search 返回 {entry, score, matchedTags}，entry 才是条目
 * - 中文检索需用 content 中真实存在的词（title 列不做 bigram）
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from '../src/tools/sqlite.js';
import { Fts5Retriever } from '../src/knowledge/fts5-retriever.js';
import { StructuredStore } from '../src/knowledge/structured-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-sqlite-'));
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

// ── 1. 封装层基础 API ────────────────────────────────
console.log('\n[1] 封装层 sqlite.ts');
{
  const db = Database(path.join(tmp, 'base.db'));
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
  const ins = db.prepare('INSERT INTO t(name) VALUES (?)');
  const r = ins.run('hello');
  check('run 返回 {changes, lastInsertRowid}', typeof r.changes === 'number' && r.lastInsertRowid !== undefined, JSON.stringify(r));
  const all = db.prepare('SELECT * FROM t').all();
  check('all 返回行', all.length === 1 && all[0].name === 'hello');
  const one = db.prepare('SELECT * FROM t WHERE id = ?').get(1);
  check('get 返回单行', one?.name === 'hello');
  db.pragma('journal_mode = WAL');
  check('pragma 不抛错', true);
  const tx = db.transaction((n: number) => {
    db.prepare('INSERT INTO t(name) VALUES (?)').run(`tx-${n}`);
    return n * 2;
  });
  const txr = tx(5);
  check('transaction 提交成功并返回结果', txr === 10);
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number };
  check('事务内插入生效', cnt.c === 2);
  const txFail = db.transaction(() => {
    db.prepare('INSERT INTO t(name) VALUES (?)').run('bad');
    throw new Error('rollback me');
  });
  try { txFail(); } catch { /* 预期 */ }
  const cnt2 = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number };
  check('事务回滚生效', cnt2.c === 2);
  db.close();
  check('close 不抛错', true);
}

// ── 2. 只读模式 ──────────────────────────────────────
console.log('\n[2] 只读模式');
{
  const db = Database(path.join(tmp, 'base.db'), { readonly: true });
  const row = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number };
  check('只读可查询', row.c === 2);
  let threw = false;
  try { db.prepare('INSERT INTO t(name) VALUES (?)').run('x'); } catch { threw = true; }
  check('只读拒绝写入', threw);
  db.close();
}

// ── 3. Fts5Retriever（中文 bigram）────────────────────
console.log('\n[3] Fts5Retriever');
{
  const r = new Fts5Retriever(path.join(tmp, 'kb', 'fts.db'));
  r.add({ id: 'd1', title: '知识库迁移', source: 'test.md', content: 'better-sqlite3 需要 C 编译环境，迁移到 node 内置 SQLite。' });
  r.add({ id: 'd2', title: '纯英文', source: 'en.md', content: 'The quick brown fox jumps over the lazy dog.' });
  const zh = r.search('需要', 5);
  check('中文 bigram 命中', zh.length > 0 && zh[0].title === '知识库迁移', JSON.stringify(zh.map(x => x.title)));
  const zh2 = r.search('迁移', 5);
  check('中文多词命中', zh2.some(x => x.title === '知识库迁移'));
  const en = r.search('fox', 5);
  check('英文命中', en.some(x => x.title === '纯英文'), JSON.stringify(en.map(x => x.title)));
  const count = r.count();
  check('count', count === 2);
  const list = r.list();
  check('list', list.length === 2);
  r.close();
}

// ── 4. StructuredStore（结构化 + tag）────────────────
console.log('\n[4] StructuredStore');
{
  const s = new StructuredStore(path.join(tmp, 'kb', 'struct.db'));
  s.add({ id: 'e1', title: 'SQLite 迁移', tags: ['sqlite', 'refactor'], content: '封装层方案' });
  s.add({ id: 'e2', title: 'Node 内置模块', tags: ['node'], content: 'node:sqlite 零依赖' });
  const byTag = s.search('sqlite', 5);
  check('tag 命中', byTag.some(x => x.entry.id === 'e1'), JSON.stringify(byTag.map(x => x.entry.id)));
  // FTS 兜底验证：'sqlite' tag 命中 e1 后 main<2，FTS 兜底应补入 content 含 'sqlite' 的 e2
  check('FTS 兜底补入 e2', byTag.some(x => x.entry.id === 'e2'), JSON.stringify(byTag.map(x => x.entry.id)));
  const got = s.get('e1');
  check('get 按 id', got?.title === 'SQLite 迁移');
  s.close();
}

// ── 清理（确保所有连接已 close，避免 EPERM）────────────
console.log('\n[5] 清理');
{
  try { fs.rmSync(tmp, { recursive: true, force: true }); check('临时目录清理', true); }
  catch (e) { check('临时目录清理', false, (e as Error).message); }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
