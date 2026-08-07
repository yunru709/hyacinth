/**
 * MediaStore 测试 — 独立媒体库（SQLite 索引 + 文件管理）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaStore } from './media-store.js';

describe('MediaStore', () => {
  let tmpDir: string;
  let store: MediaStore;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
    dbPath = path.join(tmpDir, 'media.sqlite');
    store = new MediaStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('创建独立数据库 + files 目录', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'files'))).toBe(true);
    expect(store.count()).toBe(0);
  });

  it('importFile 复制文件并登记索引', () => {
    const src = path.join(tmpDir, 'src.png');
    fs.writeFileSync(src, 'fake-png-bytes');
    const rec = store.importFile(src, {
      type: 'image',
      source: 'scene',
      character: '小蝶',
      signature: 'abc123',
      prompt: '森林小屋',
    });
    // 唯一 ID
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    // 文件已复制到 files/
    const abs = path.join(tmpDir, rec.relPath);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('fake-png-bytes');
    // 元数据正确
    expect(rec.type).toBe('image');
    expect(rec.character).toBe('小蝶');
    expect(store.count()).toBe(1);
  });

  it('register 登记已有文件（不复制）', () => {
    const rec = store.register('files/manual.png', {
      type: 'image',
      source: 'user',
    });
    expect(rec.relPath).toBe('files/manual.png');
    expect(store.count()).toBe(1);
    // 不复制：files/manual.png 不存在也不报错
    expect(fs.existsSync(path.join(tmpDir, 'files/manual.png'))).toBe(false);
  });

  it('findBySignature 去重：同来源同角色命中，否则不命中', () => {
    const src = path.join(tmpDir, 'a.png');
    fs.writeFileSync(src, 'bytes');
    store.importFile(src, { type: 'image', source: 'scene', character: '小蝶', signature: 'sig-1' });

    const hit = store.findBySignature('sig-1', 'scene', '小蝶');
    expect(hit).toBeDefined();
    expect(hit!.id).toBeTruthy();

    // 不同角色 → 不命中
    expect(store.findBySignature('sig-1', 'scene', '柔柔')).toBeUndefined();
    // 不同来源 → 不命中
    expect(store.findBySignature('sig-1', 'generation', '小蝶')).toBeUndefined();
    // 不同签名 → 不命中
    expect(store.findBySignature('sig-2', 'scene', '小蝶')).toBeUndefined();
  });

  it('list 按 type/source/character 过滤', () => {
    const src = path.join(tmpDir, 'a.png');
    fs.writeFileSync(src, 'x');
    store.importFile(src, { type: 'image', source: 'scene', character: '小蝶' });
    store.importFile(src, { type: 'video', source: 'generation', character: '柔柔' });

    expect(store.list({ type: 'image' })).toHaveLength(1);
    expect(store.list({ source: 'generation' })).toHaveLength(1);
    expect(store.list({ character: '柔柔' })).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
    expect(store.list({ limit: 1 })).toHaveLength(1);
  });

  it('remove 删除记录并删文件', () => {
    const src = path.join(tmpDir, 'a.png');
    fs.writeFileSync(src, 'bytes');
    const rec = store.importFile(src, { type: 'image', source: 'scene' });
    const abs = path.join(tmpDir, rec.relPath);
    expect(fs.existsSync(abs)).toBe(true);

    expect(store.remove(rec.id)).toBe(true);
    expect(store.count()).toBe(0);
    expect(fs.existsSync(abs)).toBe(false);
    // 重复删除返回 false
    expect(store.remove(rec.id)).toBe(false);
  });

  it('importFile 源不存在抛错', () => {
    expect(() => store.importFile(path.join(tmpDir, 'nope.png'), { type: 'image', source: 'scene' })).toThrow(
      'not found',
    );
  });

  it('resolvePath 还原绝对路径', () => {
    const rec = store.register('files/x.png', { type: 'image', source: 'user' });
    const abs = store.resolvePath(rec);
    expect(abs).toBe(path.join(tmpDir, 'files', 'x.png'));
  });
});
