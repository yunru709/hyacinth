/**
 * session-allowlist 的契约测试（2026-10-13 代码审计 B3 的回归）
 *
 * 钉住一条最容易静默失效的性质：**会话之间互不串味**。
 *
 * 修复前的实现：
 *   const EMPTY_DATA = { allowedTools: [], allowedCommands: [], allowedWriteRoots: [], unrestricted: false };
 *   catch { return { ...EMPTY_DATA }; }        // ← 浅拷贝
 * `{ ...EMPTY_DATA }` 只复制了**引用**，`allowedWriteRoots` 等数组字段仍指向**模块级单例的同一个数组**。
 * 于是 `addWriteRoot` 里的 `data.allowedWriteRoots.push(root)` 会**改写全局** ——
 * 此后任何 `load()` 失败（新会话 / 文件缺失 / 损坏）返回的"空"数据都带着那个根
 * ⇒ **跨会话静默放行**，且没有任何日志。对一次以"收紧权限"为目标的改造，这是反向失效。
 *
 * 实测（修复前）：在 A 会话（无 allowlist.json）记一个根后，
 * `isWriteRootAllowed(B, 该根) === true`（B 从未批准过它）。
 *
 * 修法：catch 分支改 `structuredClone(EMPTY_DATA)`（深拷贝）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as allowlist from './session-allowlist.js';

describe('session-allowlist：会话隔离（审计 B3 回归）', () => {
  let dirA: string;
  let dirB: string;

  beforeAll(() => {
    // 刻意**不**创建 allowlist.json：这正是修复前被污染的那条 catch 分支
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'al-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'al-b-'));
  });

  afterAll(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('【B3】A 会话批准的写根，不得出现在从未批准过它的 B 会话里', async () => {
    const root = path.join(os.tmpdir(), 'some-approved-root');

    await allowlist.addWriteRoot(dirA, root);
    expect(await allowlist.getWriteRoots(dirA)).toEqual([root]);

    // B 从未写过任何东西 —— 修复前这里会"继承" A 的根
    expect(await allowlist.getWriteRoots(dirB)).toEqual([]);
    expect(await allowlist.isWriteRootAllowed(dirB, root)).toBe(false);
  });

  it('【B3】AOR（全放行）状态同样不跨会话', async () => {
    await allowlist.setUnrestricted(dirA, true);

    expect(allowlist.isUnrestrictedSync(dirA)).toBe(true);
    // 关键：B 必须仍是 false —— AOR 是"只认本 sessionDir"的会话级状态
    expect(allowlist.isUnrestrictedSync(dirB)).toBe(false);
  });

  it('【B3】写入的根只落进自己的会话文件，不写别处', async () => {
    const extra = path.join(os.tmpdir(), 'another-approved-root');
    await allowlist.addWriteRoot(dirA, extra);

    // A 的文件确实含两条
    const rawA = JSON.parse(fs.readFileSync(path.join(dirA, 'allowlist.json'), 'utf-8'));
    expect(rawA.allowedWriteRoots).toContain(extra);

    // B 目录里不该凭空出现 allowlist.json（除非它自己写过）
    expect(fs.existsSync(path.join(dirB, 'allowlist.json'))).toBe(false);
  });
});
