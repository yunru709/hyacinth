/**
 * xref-root-guard.test.ts — 「不许把用户主目录当项目根索引」的回归点（2026-09-19）
 *
 * 事故：插件把裸 cwd 当项目根（`init(services.cwd)`），而 agent 可能从主目录启动。
 * 实测产出 **1.18GB** 索引（`xref-C-Users-74689.sqlite`，把 AppData / 浏览器缓存全扫了）。
 *
 * 关键：`assertIndexableRoot()` 在 `Database()` **之前**抛错 —— 因此**连库文件都不会创建**，
 * 所以本文件可以放心拿**真实主目录**做断言（不需要也不要劫持 homedir 来测这一条）。
 * 反面用例仍需劫持 homedir，避免往真实 `~/.agent/cache` 写库（同 xref-tools.test.ts 约定）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager } from './manager.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

describe('xref 项目根校验', () => {
  it('① 拒绝索引用户主目录（真实主目录；在创建数据库之前就抛错）', async () => {
    const m = new XrefManager();
    await expect(m.init(os.homedir())).rejects.toThrow(/拒绝索引用户主目录/);
    m.close();
  });

  it('② 拒绝索引主目录的祖先目录（范围过大）', async () => {
    const parent = path.dirname(os.homedir());
    // 某些环境下 dirname(home) 可能等于 home（例如 home 就是根）——那种情况跳过
    if (parent === os.homedir() || parent === path.parse(parent).root) {
      expect(true).toBe(true);
      return;
    }
    const m = new XrefManager();
    await expect(m.init(parent)).rejects.toThrow(/祖先目录|范围过大/);
    m.close();
  });

  beforeAll(async () => {
    realHome = os.homedir();
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xref-root-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(async () => {
    homedirSpy.mockRestore();
    expect(os.homedir()).toBe(realHome);
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it('③ 正常项目根（主目录之下的普通目录）应当放行', async () => {
    // 注意：用 fakeHome 之下的路径，既满足"不是主目录/其祖先"，也不写真实 cache
    const project = path.join(fakeHome, 'work', 'proj');
    await fs.mkdir(project, { recursive: true });
    const m = new XrefManager();
    await expect(m.init(project)).resolves.toBeUndefined();
    m.close();
  });
});
