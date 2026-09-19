/**
 * anchor.test.ts — 项目锚解析（任务单四.1）
 *
 * 为什么需要：索引按 projectKey 分库，而插件传进来的是 cwd —— **cwd 不等于项目根**。
 * 同一个项目从仓库根启动与从 src/ 子目录启动会各建一个库、互相看不见。
 * 本文件锁住锚的依据链与两条硬约束。
 *
 * 判据（都对着行为，不看文档）：
 *  ① 标记 / .git / 环境变量三条路径各一例，且优先级正确（.git 胜过更近的标记）；
 *  ② **绝不枚举目录内容** —— 直接断言 readdir 系列从未被调用（探测必须极廉价，
 *     枚举会把"探测"变成"扫描"，在主目录那类大树上代价失控）；
 *  ③ 禁区不作锚：命中即退回起点 + 警告，不抛错（锚只是分库键，拿不准就用起点）；
 *  ④ **同一项目多入口收敛到同一份索引**（本项真正的验收：构建一次、从另一入口能查到）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveAnchor, isForbiddenAnchor } from './anchor.js';
import { XrefManager } from './manager.js';

const created: string[] = [];

async function tmpProject(structure: Record<string, string>): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anchor-'));
  created.push(root);
  for (const [rel, content] of Object.entries(structure)) {
    const p = path.join(root, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    if (rel.endsWith('.git') || content === 'DIR') {
      await fsp.mkdir(p, { recursive: true });
    } else {
      await fsp.writeFile(p, content, 'utf-8');
    }
  }
  return root;
}

afterEach(async () => {
  delete process.env.HYACINTH_XREF_ROOT;
  for (const d of created.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

describe('resolveAnchor：依据链', () => {
  it('① 项目标记：子目录启动 → 锚到带 package.json 的那层', async () => {
    const root = await tmpProject({ 'package.json': '{}', 'src/deep/file.ts': 'export const a = 1;' });
    const r = resolveAnchor(path.join(root, 'src', 'deep'));
    expect(fs.realpathSync(r.root)).toBe(fs.realpathSync(root));
    expect(r.reason).toBe('marker:package.json');
    expect(r.warning).toBeUndefined();
  });

  it('① .git 优先于更近的标记（有 .git 的那层才是项目根）', async () => {
    const root = await tmpProject({ '.git': 'DIR', 'src/package.json': '{}' });
    const r = resolveAnchor(path.join(root, 'src'));
    expect(fs.realpathSync(r.root)).toBe(fs.realpathSync(root));
    expect(r.reason).toBe('git');
  });

  it('① 环境变量是 agent 的显式声明，优先级最高', async () => {
    const proj = await tmpProject({ 'package.json': '{}' });
    const other = await tmpProject({ 'go.mod': 'module x' });
    process.env.HYACINTH_XREF_ROOT = other;
    const r = resolveAnchor(proj);
    expect(fs.realpathSync(r.root)).toBe(fs.realpathSync(other));
    expect(r.reason).toBe('env');
  });

  it('① 环境变量指向禁区 → 忽略并退回起点 + 警告', async () => {
    const proj = await tmpProject({ 'package.json': '{}' });
    process.env.HYACINTH_XREF_ROOT = os.homedir();
    const r = resolveAnchor(proj);
    expect(fs.realpathSync(r.root)).toBe(fs.realpathSync(proj));
    expect(r.reason).toBe('cwd');
    expect(r.warning).toContain('禁区');
  });

  it('② 绝不枚举目录内容：readdir 系列一次都不能被调用', async () => {
    const root = await tmpProject({ 'package.json': '{}', 'src/deep/file.ts': 'x' });
    const spies = [
      vi.spyOn(fs, 'readdirSync'),
      vi.spyOn(fs, 'opendirSync'),
      vi.spyOn(fsp, 'readdir'),
      vi.spyOn(fsp, 'opendir'),
    ];
    try {
      resolveAnchor(path.join(root, 'src', 'deep'));
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('③ 禁区（主目录本身）不作锚：退回起点 + 警告，不抛错', () => {
    expect(isForbiddenAnchor(os.homedir())).toBe(true);
    const r = resolveAnchor(os.homedir());
    expect(r.reason).toBe('cwd');
    expect(r.warning).toBeTruthy();
  });
});

describe('④ 同一项目多入口 → 同一份索引（本项真正的验收）', () => {
  it('从仓库根构建一次，从子目录启动仍能查到同一份索引', async () => {
    const realHome = os.homedir();
    const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'anchor-home-'));
    created.push(fakeHome);
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    try {
      const root = await tmpProject({
        'package.json': '{}',
        'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
      });

      // 入口一：仓库根
      const m1 = new XrefManager();
      await m1.init(root);
      expect(m1.getAnchorInfo()?.reason).toBe('marker:package.json');
      await m1.build(undefined, undefined, 50, { force: true });
      m1.close();

      // 入口二：子目录（模拟"从 src/ 启动的另一个 session"）
      const m2 = new XrefManager();
      await m2.init(path.join(root, 'src'));
      // 锚一致 ⇒ 库路径一致 ⇒ 无需重建即可查到入口一建好的索引
      const stats = await m2.build(undefined, undefined, 50);
      expect(stats.parsed_files).toBe(0); // 什么都没重解析：说明复用了同一份库
      const { XrefQueryTool } = await import('./xref-query.js');
      const out = await new XrefQueryTool(m2).execute({ action: 'defs', symbol: 'alpha' });
      expect(out).toContain('a.ts');
      m2.close();
    } finally {
      spy.mockRestore();
      expect(os.homedir()).toBe(realHome);
    }
  });
});
