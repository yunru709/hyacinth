/**
 * project-root 单测 —— xref「索引哪个项目」的根解析、记忆与库清点。
 *
 * 背景（2026-10-07 实测事故）：根此前只能取 agent 的启动目录；从用户主目录启动时
 * 被安全闸拒绝（防扫 AppData）⇒ 插件静默 idle、三个工具全不注册。本模块是
 * "根可指定、可记住、可清点"的地基，用测试守住三件事：
 *   ① 优先级：显式参数 > 记忆 > 兜底
 *   ② 记忆文件缺失/损坏 ⇒ 退化为"没记住"，绝不抛错、绝不阻塞建索引
 *   ③ 清点不把打不开的库误判为孤儿（误删比漏报危险）
 *
 * 隔离：劫持 os.homedir() 指向临时目录。本模块的路径全部由 homedir 推得，
 * 不劫持就会写到真实 ~/.agent（含用户已有的库）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  xrefStatePath,
  readRememberedRoot,
  rememberRoot,
  resolveActiveRoot,
  listXrefIndexes,
} from './project-root.js';
import { XrefManager } from './manager.js';

let tmpRoot: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xref-root-'));
  fakeHome = path.join(tmpRoot, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const cacheDir = (): string => path.join(fakeHome, '.agent', 'cache');

describe('resolveActiveRoot — 优先级', () => {
  it('显式参数优先于一切', () => {
    rememberRoot('C:/remembered/proj');
    expect(resolveActiveRoot('C:/explicit/proj', 'C:/bound/proj')).toBe(path.resolve('C:/explicit/proj'));
  });

  it('已绑定的根优先于记忆（记忆不得把它拽回上一个项目）', () => {
    rememberRoot('C:/remembered/proj');
    expect(resolveActiveRoot(undefined, 'C:/bound/proj')).toBe('C:/bound/proj');
  });

  it('尚未绑定任何根时，用记忆做初始绑定', () => {
    rememberRoot('C:/remembered/proj');
    expect(resolveActiveRoot(undefined, undefined)).toBe('C:/remembered/proj');
  });

  it('尚未绑定且无记忆时用兜底（空串 fallback 不算数）', () => {
    expect(resolveActiveRoot(undefined, '')).toBeNull();
  });

  it('三者皆无 ⇒ null（调用方据此给出可操作提示，而不是去扫主目录）', () => {
    expect(resolveActiveRoot(undefined, undefined)).toBeNull();
  });
});

describe('记忆读写', () => {
  it('rememberRoot → readRememberedRoot 往返', () => {
    expect(readRememberedRoot()).toBeNull(); // 初始：没记住任何东西
    rememberRoot('C:/a/b');
    expect(readRememberedRoot()).toBe('C:/a/b');
  });

  it('记忆文件损坏 ⇒ 退化为 null，不抛错', () => {
    fs.mkdirSync(path.dirname(xrefStatePath()), { recursive: true });
    fs.writeFileSync(xrefStatePath(), '{ this is not json', 'utf-8');
    expect(() => readRememberedRoot()).not.toThrow();
    expect(readRememberedRoot()).toBeNull();
  });

  it('字段类型不对（非字符串）⇒ null', () => {
    fs.mkdirSync(path.dirname(xrefStatePath()), { recursive: true });
    fs.writeFileSync(xrefStatePath(), JSON.stringify({ activeRoot: 42 }), 'utf-8');
    expect(readRememberedRoot()).toBeNull();
  });

  it('空白字符串不算记忆（避免把空根写进后续链路）', () => {
    fs.mkdirSync(path.dirname(xrefStatePath()), { recursive: true });
    fs.writeFileSync(xrefStatePath(), JSON.stringify({ activeRoot: '   ' }), 'utf-8');
    expect(readRememberedRoot()).toBeNull();
  });
});

describe('listXrefIndexes — 清点', () => {
  it('目录不存在 / 无库 ⇒ 空数组，不报错', () => {
    expect(listXrefIndexes(cacheDir())).toEqual([]);
  });

  it('真实建库后能被清点出来（根、占用、孤儿/禁区标记）', async () => {
    const proj = path.join(tmpRoot, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), '{}', 'utf-8');

    const m = new XrefManager();
    await m.init(proj);
    m.close();

    const entries = listXrefIndexes(cacheDir());
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.rootDir.replace(/\\/g, '/')).toBe(proj.replace(/\\/g, '/'));
    expect(e.orphan).toBe(false);
    expect(e.suspectRoot).toBe(false);
    expect(e.bytes).toBeGreaterThan(0);
  });

  it('根目录已消失 ⇒ 判孤儿；打不开的库不判孤儿（宁可漏报，不可误删）', async () => {
    const gone = path.join(tmpRoot, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    fs.writeFileSync(path.join(gone, 'package.json'), '{}', 'utf-8');
    const m = new XrefManager();
    await m.init(gone);
    m.close();
    fs.rmSync(gone, { recursive: true, force: true }); // 项目目录没了 ⇒ 库成了孤儿

    // 再放一个打不开的"库"（非 SQLite 内容）⇒ 根读不出 ⇒ 不判孤儿
    fs.writeFileSync(path.join(cacheDir(), 'xref-broken.sqlite'), 'not a sqlite file', 'utf-8');

    const entries = listXrefIndexes(cacheDir());
    const orphanEntry = entries.find((e) => e.key.includes('gone'));
    const brokenEntry = entries.find((e) => e.key === 'broken');
    expect(orphanEntry?.orphan).toBe(true);
    expect(brokenEntry).toBeDefined();
    expect(brokenEntry?.orphan).toBe(false);
    expect(brokenEntry?.rootDir).toBe('');
  });
});
