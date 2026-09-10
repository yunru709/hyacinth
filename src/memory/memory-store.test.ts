/**
 * MemoryStore 单测（报告 M3 P0：memory-store 无护航）
 *
 * 用 mkdtemp 独立临时目录（不删除，遵守 de-flake 教训——测试环境
 * fs.rmSync 被 safe-delete shim 劫持成回收站，满载会 ETIMEDOUT）。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { MemoryStore } from './memory-store.js';

const HEADER = '<!-- Memory managed by Agent. Edit directly or use /memory command. -->';

/** 唯一临时目录（每次调用独立，避免用例间文件残留干扰） */
function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-store-'));
}

describe('MemoryStore', () => {
  it('文件不存在时 load() 返回空串（不抛错）', () => {
    const store = new MemoryStore(path.join(makeDir(), 'memory.md'));
    expect(store.load()).toBe('');
  });

  it('save + load round-trip', () => {
    const store = new MemoryStore(path.join(makeDir(), 'memory.md'));
    store.save('第一条记忆');
    expect(store.load()).toBe('第一条记忆');
  });

  it('save 自动创建深层目录', () => {
    const dir = path.join(makeDir(), 'a', 'b', 'c');
    const store = new MemoryStore(path.join(dir, 'memory.md'));
    store.save('deep');
    expect(fs.existsSync(path.join(dir, 'memory.md'))).toBe(true);
    expect(store.load()).toBe('deep');
  });

  it('append：空文件直接写入；已有内容以空行分隔追加', () => {
    const store = new MemoryStore(path.join(makeDir(), 'memory.md'));
    store.append('第一条');
    expect(store.load()).toBe('第一条');

    store.append('第二条');
    expect(store.load()).toBe('第一条\n\n第二条');
  });

  it('formatForContext：空内容返回空串；有内容带 HEADER', () => {
    const empty = new MemoryStore(path.join(makeDir(), 'empty.md'));
    expect(empty.formatForContext()).toBe('');

    const store = new MemoryStore(path.join(makeDir(), 'mem.md'));
    store.save('记忆正文');
    expect(store.formatForContext()).toBe(`${HEADER}\n\n记忆正文`);
  });

  it('initializeIfNeeded：文件不存在时创建带 HEADER 的占位；已存在不改动', () => {
    const filePath = path.join(makeDir(), 'mem.md');
    const store = new MemoryStore(filePath);
    store.initializeIfNeeded();
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(`${HEADER}\n\n`);

    // 已有内容 → 不动
    store.save('用户写入的内容');
    store.initializeIfNeeded();
    expect(store.load()).toBe('用户写入的内容');
  });

  it('getFilePath 返回构造路径', () => {
    const p = path.join(makeDir(), 'mem.md');
    const store = new MemoryStore(p);
    expect(store.getFilePath()).toBe(p);
  });
});
