/**
 * Fts5Retriever 单测（报告 M3 P0：knowledge 0 测试护航）
 *
 * 用 mkdtemp 独立临时目录建库（每用例独立 db 文件），**不删除**临时目录
 * （遵守 de-flake 教训：测试环境 fs.rmSync 被 safe-delete shim 劫持成回收站，
 * 满载时 spawn trash 二进制会 ETIMEDOUT——临时目录交由 os.tmpdir 自清）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { Fts5Retriever } from './fts5-retriever.js';
import type { KbDocument } from './retriever.js';
import { preprocessQuery } from './query-preprocessor.js';

// ── helpers ─────────────────────────────────────────────────────────

const openDbs: Fts5Retriever[] = [];

/** 每个用例独立的临时库（唯一路径避免 WAL 并发/复用干扰） */
function makeDb(): Fts5Retriever {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fts5-'));
  const db = new Fts5Retriever(path.join(dir, 'kb.db'));
  openDbs.push(db);
  return db;
}

function doc(over: Partial<KbDocument> = {}): KbDocument {
  return {
    id: crypto.randomUUID(),
    title: 't',
    source: '',
    content: 'content',
    ...over,
  };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try { db.close(); } catch { /* 已关闭忽略 */ }
  }
});

// ── 测试 ────────────────────────────────────────────────────────────

describe('Fts5Retriever 基础 CRUD', () => {
  it('add 返回自动生成的 id，count/list 反映', () => {
    const db = makeDb();
    expect(db.count()).toBe(0);
    const id = db.add(doc({ title: '文档一', source: 'a.md', content: '这是知识库的第一份文档' }));
    expect(id).toBeTruthy();
    expect(db.count()).toBe(1);
    const docs = db.list();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe('文档一');
    expect(docs[0]!.source).toBe('a.md');
  });

  it('add 保留调用方指定的 id', () => {
    const db = makeDb();
    expect(db.add(doc({ id: 'fixed-id' }))).toBe('fixed-id');
    expect(db.count()).toBe(1);
  });

  it('remove：命中返回 true 且删除，未命中返回 false', () => {
    const db = makeDb();
    const id = db.add(doc());
    expect(db.remove(id)).toBe(true);
    expect(db.count()).toBe(0);
    expect(db.remove(id)).toBe(false);
  });

  it('findBySource：命中返回 id，未命中 undefined', () => {
    const db = makeDb();
    const id = db.add(doc({ source: '/docs/x.md' }));
    expect(db.findBySource('/docs/x.md')?.id).toBe(id);
    expect(db.findBySource('/docs/absent.md')).toBeUndefined();
  });
});

describe('Fts5Retriever 检索（英文/非中文）', () => {
  it('关键词检索命中，snippet 带高亮', () => {
    const db = makeDb();
    db.add(doc({ title: 'How it works', source: 'en.md', content: 'The retriever uses BM25 ranking across the full text index.' }));
    db.add(doc({ title: 'Unrelated', source: 'other.md', content: 'Pizza recipes and cooking tips.' }));

    const hits = db.search('retriever', 5);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((h) => h.title === 'How it works');
    expect(hit).toBeTruthy();
    expect(hit!.snippet).toContain('<b>'); // FTS5 高亮标签
    // 不相关文档不应命中
    expect(hits.some((h) => h.title === 'Unrelated')).toBe(false);
  });

  it('空查询返回空数组', () => {
    const db = makeDb();
    db.add(doc({ content: 'anything' }));
    expect(db.search('', 5)).toEqual([]);
    expect(db.search('   ', 5)).toEqual([]);
  });

  it('无匹配返回空数组（不抛错）', () => {
    const db = makeDb();
    db.add(doc({ content: 'alpha beta' }));
    expect(db.search('zzzzz-not-exist', 5)).toEqual([]);
  });

  it('k 限制返回数量', () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) db.add(doc({ title: `doc${i}`, content: 'shared keyword body' }));
    expect(db.search('keyword', 2)).toHaveLength(2);
  });

  it('去重：同一 title+source 的重复行合并', () => {
    const db = makeDb();
    // 同一 source 追加多段内容 → FTS 行多，但结果按 title+source 去重
    for (let i = 0; i < 3; i++) {
      db.add(doc({ title: '同标题', source: 'dup.md', content: `keyword segment ${i}` }));
    }
    const hits = db.search('keyword', 5);
    const titles = hits.map((h) => h.title + '|' + h.source);
    expect(new Set(titles).size).toBe(titles.length); // 无重复键
  });
});

describe('Fts5Retriever 中文检索（bigram）', () => {
  it('中文关键词命中（bigram 索引）', () => {
    const db = makeDb();
    db.add(doc({ title: '公司介绍', content: '风信子公司专注于人工智能助手的研发与落地' }));
    db.add(doc({ title: '无关', content: '今天天气很好适合出去散步' }));

    const hits = db.search('人工智能', 5);
    expect(hits.some((h) => h.title === '公司介绍')).toBe(true);
    expect(hits.some((h) => h.title === '无关')).toBe(false);
  });

  it('中文查询含停用词 → 变体链降级仍能命中', () => {
    const db = makeDb();
    db.add(doc({ title: '同桌档案', content: '我的同桌是李明，他喜欢打篮球' }));

    const { variants } = preprocessQuery('我的同桌是谁');
    expect(variants.length).toBeGreaterThan(0);
    const hits = db.search('我的同桌是谁', 5);
    // 变体链至少尝试「同桌」「李明」等关键词 → 应命中同桌档案
    expect(hits.some((h) => h.title === '同桌档案')).toBe(true);
  });
});

describe('Fts5Retriever 更新', () => {
  it('update content 同步 fts_content：新内容可搜、旧内容不可搜', () => {
    const db = makeDb();
    const id = db.add(doc({ title: '旧标题', content: 'old keyword alpha' }));
    expect(db.search('alpha', 5)).toHaveLength(1);

    expect(db.update(id, { content: 'brand new keyword beta' })).toBe(true);
    expect(db.search('alpha', 5)).toHaveLength(0);
    expect(db.search('beta', 5)).toHaveLength(1);
  });

  it('update title 生效', () => {
    const db = makeDb();
    const id = db.add(doc({ title: 'old title' }));
    expect(db.update(id, { title: 'new title' })).toBe(true);
    const docs = db.list();
    expect(docs[0]!.title).toBe('new title');
  });

  it('update 不存在的 id 返回 false，空字段返回 false', () => {
    const db = makeDb();
    expect(db.update('no-such-id', { content: 'x' })).toBe(false);
    const id = db.add(doc());
    expect(db.update(id, {})).toBe(false);
  });
});
