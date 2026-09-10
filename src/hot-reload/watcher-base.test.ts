// ============================================================
// Watcher 统一骨架测试
// ============================================================
// 用真实临时文件系统驱动（vi.useFakeTimers 与 fs.watch 事件循环
// 冲突，故用短间隔 + 轮询等待），覆盖：
//  1. watch 模式：文件变更 → reload 收到 trigger（filename/dir）
//  2. 防抖：debounce 窗口内多次变更只触发一次 reload
//  3. filter：不匹配的 filename 不触发
//  4. shouldSkip：true 时 reload 被跳过（竞态保护钩子位置）
//  5. reload 抛错：骨架捕获，进程不崩、监听器不受影响
//  6. poll 模式：mtime 变化触发 reload；mtime 不变不触发
//  7. 监听路径不存在：静默跳过，返回空句柄
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatcher, type WatcherSpec } from './watcher-base.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-base-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 轮询等待条件成立（fake timers 与 fs.watch 事件循环冲突，用真实等待） */
async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function touch(filePath: string, content = 'x'): void {
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('watch 模式（fs.watch 事件驱动）', () => {
  it('文件变更 → reload 收到 filename 与 dir 上下文', async () => {
    const dir = tmpDir();
    touch(path.join(dir, 'a.json'));
    const triggers: { filename: string | null; dir: string }[] = [];
    const spec: WatcherSpec = {
      name: 'test',
      paths: () => [dir],
      reload: (t) => { triggers.push(t); },
    };
    const handles = createWatcher(spec);
    expect(handles.length).toBe(1);

    touch(path.join(dir, 'a.json'), 'changed');
    await waitFor(() => triggers.length > 0);
    expect(triggers[0]!.dir).toBe(dir);
    expect(triggers[0]!.filename).toBe('a.json');
    handles.forEach((h) => h.close());
  });

  it('防抖：窗口内多次变更只触发一次 reload', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'b.json');
    touch(file);
    let calls = 0;
    const handles = createWatcher({
      name: 'test-debounce',
      paths: () => [dir],
      debounceMs: 120,
      reload: () => { calls++; },
    });

    touch(file, '1');
    await new Promise((r) => setTimeout(r, 30));
    touch(file, '2');
    await new Promise((r) => setTimeout(r, 30));
    touch(file, '3');

    // 防抖窗口（120ms）过后恰好一次
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(1);
    handles.forEach((h) => h.close());
  });

  it('filter：不匹配的 filename 不触发 reload', async () => {
    const dir = tmpDir();
    let calls = 0;
    const handles = createWatcher({
      name: 'test-filter',
      paths: () => [dir],
      filter: (f) => f.endsWith('.md'),
      reload: () => { calls++; },
    });

    touch(path.join(dir, 'ignored.txt'), 'no');
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(0);

    touch(path.join(dir, 'matched.md'), 'yes');
    await waitFor(() => calls > 0);
    handles.forEach((h) => h.close());
  });

  it('shouldSkip=true → reload 跳过；false 后恢复', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'c.json');
    touch(file);
    let calls = 0;
    let skipping = true;
    const handles = createWatcher({
      name: 'test-skip',
      paths: () => [dir],
      debounceMs: 30,
      shouldSkip: () => skipping,
      reload: () => { calls++; },
    });

    touch(file, 'v1');
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(0); // skipping 期间不触发

    skipping = false;
    touch(file, 'v2');
    await waitFor(() => calls > 0);
    handles.forEach((h) => h.close());
  });

  it('reload 抛错 → 骨架捕获，后续变更仍可触发', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'd.json');
    touch(file);
    let calls = 0;
    let fail = true;
    const handles = createWatcher({
      name: 'test-err',
      paths: () => [dir],
      debounceMs: 20,
      reload: () => {
        calls++;
        if (fail) throw new Error('boom');
      },
    });

    touch(file, 'v1');
    await waitFor(() => calls === 1);
    fail = false;
    touch(file, 'v2');
    await waitFor(() => calls === 2);
    handles.forEach((h) => h.close());
  });

  it('监听路径不存在 → 静默跳过（返回空句柄，不抛错）', () => {
    const handles = createWatcher({
      name: 'test-missing',
      paths: () => [path.join(tmpDir(), 'no-such-file.json')],
      reload: () => {},
    });
    expect(handles).toEqual([]);
  });
});

describe('poll 模式（fs.watchFile stat 轮询）', () => {
  it('mtime 变化 → reload（filename=null）；mtime 不变不触发', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'e.json');
    touch(file);
    const triggers: { filename: string | null; dir: string }[] = [];
    const handles = createWatcher({
      name: 'test-poll',
      mode: 'poll',
      pollIntervalMs: 60,
      paths: () => [file],
      reload: (t) => { triggers.push(t); },
    });

    // mtime 不变：短窗口内不触发
    await new Promise((r) => setTimeout(r, 150));
    expect(triggers.length).toBe(0);

    // mtime 变化：触发一次，且短窗口内不重复触发
    touch(file, 'changed');
    await waitFor(() => triggers.length >= 1);
    expect(triggers[0]!.filename).toBeNull();
    expect(triggers[0]!.dir).toBe(file);
    const n = triggers.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(triggers.length).toBe(n);
    handles.forEach((h) => h.close());
  });

  it('初始不存在的文件被创建后 → 触发 reload', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'created-later.json');
    let calls = 0;
    const handles = createWatcher({
      name: 'test-poll-create',
      mode: 'poll',
      pollIntervalMs: 60,
      paths: () => [file],
      reload: () => { calls++; },
    });

    touch(file, 'born');
    await waitFor(() => calls >= 1);
    handles.forEach((h) => h.close());
  });
});
