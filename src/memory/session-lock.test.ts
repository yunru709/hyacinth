// session-lock.test.ts — 跨进程会话目录文件锁单测
// 覆盖：正常执行与释放、并发串行化、fn 抛错仍释放、陈旧锁回收、活跃锁超时。
// 用 os.tmpdir 独立目录，不触碰真实 ~/.agent/sessions。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withSessionDirLock } from './session-lock.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sesslock-'));
}

describe('withSessionDirLock', () => {
  it('正常执行 fn 并释放锁（.lock 被删除）', async () => {
    const dir = await tmpDir();
    let ran = false;
    await withSessionDirLock(dir, async () => { ran = true; });
    expect(ran).toBe(true);
    await expect(fs.access(path.join(dir, '.lock'))).rejects.toThrow();
  });

  it('并发获取同一目录时串行执行（无并发交叉）', async () => {
    const dir = await tmpDir();
    let active = 0;
    let maxActive = 0;
    const task = () => withSessionDirLock(dir, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
    });
    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
  });

  it('fn 抛错时锁仍释放', async () => {
    const dir = await tmpDir();
    await expect(withSessionDirLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(fs.access(path.join(dir, '.lock'))).rejects.toThrow();
  });

  it('陈旧锁（超时）可回收', async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, '.lock'),
      JSON.stringify({ pid: process.pid, ts: Date.now() - 300_000 }),
      'utf-8',
    );
    let ran = false;
    await withSessionDirLock(dir, async () => { ran = true; }, { retryMs: 10, maxAttempts: 5 });
    expect(ran).toBe(true);
  });

  it('陈旧锁（pid 已退出）可回收', async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, '.lock'),
      JSON.stringify({ pid: 999999999, ts: Date.now() }),
      'utf-8',
    );
    let ran = false;
    await withSessionDirLock(dir, async () => { ran = true; }, { retryMs: 10, maxAttempts: 5 });
    expect(ran).toBe(true);
  });

  it('活跃锁（未超时）重试耗尽后抛错', async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, '.lock'),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
      'utf-8',
    );
    await expect(
      withSessionDirLock(dir, async () => {}, { staleMs: 60_000, retryMs: 10, maxAttempts: 3 }),
    ).rejects.toThrow('lock timeout');
  });
  it('空锁文件（open 与 write 之间的窗口）不得被误判为陈旧 —— 否则活锁被删、两个持有者并存', async () => {
    // 实测根因（2026-09-19，由"并发串行化"那条断言在负载下抓到 maxActive=2）：
    //   取锁是 open(wx) **先创建**、随后才 writeFile(pid/ts) ⇒ 这中间锁文件是**空的**；
    //   并发读者 JSON.parse('') 抛错 → 旧实现的 catch 直接 return true（判陈旧）
    //   ⇒ **删掉活锁** ⇒ 两个任务同时进入临界区。
    // 本用例把那个窗口**确定性地**造出来（空文件 + 新鲜 mtime），不依赖机器负载。
    const dir = await tmpDir();
    const lockPath = path.join(dir, '.lock');
    await fs.writeFile(lockPath, '', 'utf-8'); // 模拟"已创建、还没写入内容"的活锁

    let acquired = false;
    // 窗口取得**极短**（5×10ms），我们只关心一件事：尝试者会不会把**活锁**删掉/抢走。
    // ⚠️ 首版写成"等它超时前我手动 rm 释放、再断言它拿到了" —— 那依赖 `fs.rm` 成功，
    //    而 Windows 上 .lock 的删除在负载下会 EPERM（本项目已知环境问题）⇒ 锁没释放 ⇒
    //    等待者超时抛错 ⇒ 在我 await 之前就 reject ⇒ 未处理错误 ⇒ 全量跑时假红。
    //    改成"注定拿不到"的形态后，断言不依赖任何释放动作，负载再大也确定。
    const waiter = withSessionDirLock(
      dir,
      async () => { acquired = true; },
      { staleMs: 60_000, retryMs: 10, maxAttempts: 5 }, // 远未超时 ⇒ 必然重试到耗尽
    );
    await expect(waiter).rejects.toThrow(/lock timeout/); // 等它跑完（并吃掉这次"预期内的拒绝"）
    expect(acquired, '新鲜的空锁必须被当成活锁（不得被抢走）').toBe(false);
    await expect(fs.access(lockPath)).resolves.toBeUndefined(); // 且**没被误删**（旧实现会删它）
  });

});
