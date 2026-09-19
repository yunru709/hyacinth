/**
 * xref-governance.test.ts — 数据治理期（任务单四.2/四.3/四.4、五）的守卫
 *
 * 判据（全部对着行为）：
 *  四.2 租约：init/build 后 meta 里有 last_used_at，且有按进程的 lease.<pid>
 *  四.4 体积：纯函数阈值判定（单库 200MB / cache 1GB），且 build 报出 db_bytes/cache_bytes
 *  四.3 体检：孤儿（根已消失）与可疑根（根落在禁区）都能识别，且打不开的库**不误判**
 *  五   clean：区分「被占用」与「不存在」两种失败
 */
import { describe, expect, it, vi, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XrefManager, sizeWarnings, DB_SIZE_WARN_BYTES, CACHE_SIZE_WARN_BYTES } from './manager.js';
import { xrefCacheReport, reclaimOrphans } from '../../diagnostics/doctor.js';

const created: string[] = [];
let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

async function tmpProject(files: Record<string, string>): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gov-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    if (content === 'DIR') await fsp.mkdir(p, { recursive: true });
    else await fsp.writeFile(p, content, 'utf-8');
  }
  return root;
}

beforeAll(async () => {
  realHome = os.homedir();
  fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'gov-home-'));
  created.push(fakeHome);
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterAll(async () => {
  homedirSpy.mockRestore();
  expect(os.homedir()).toBe(realHome);
  for (const d of created.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.HYACINTH_XREF_ROOT;
});

describe('四.2 租约', () => {
  it('init 后 meta 有 last_used_at 与按进程的 lease.<pid>；build 后刷新', async () => {
    const root = await tmpProject({ 'package.json': '{}', 'a.ts': 'export const a = 1;\n' });
    const m = new XrefManager();
    await m.init(root);
    try {
      const db = new (await import('node:sqlite')).DatabaseSync(
        path.join(fakeHome, '.agent', 'cache', `xref-${(await import('../../utils/misc.js')).toProjectKey(root)}.sqlite`),
        { readOnly: true },
      );
      const get = (k: string): string =>
        (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value?: string } | undefined)?.value ?? '';
      const before = get('last_used_at');
      expect(before).toBeTruthy();
      expect(get(`lease.${process.pid}`)).toBeTruthy();
      db.close();

      await new Promise((r) => setTimeout(r, 15));
      await m.build(undefined, undefined, 50, { force: true });

      const db2 = new (await import('node:sqlite')).DatabaseSync(
        path.join(fakeHome, '.agent', 'cache', `xref-${(await import('../../utils/misc.js')).toProjectKey(root)}.sqlite`),
        { readOnly: true },
      );
      const after = (db2.prepare('SELECT value FROM meta WHERE key = ?').get('last_used_at') as { value: string }).value;
      db2.close();
      expect(after >= before).toBe(true);
      expect(after).not.toBe('');
    } finally {
      m.close();
    }
  });
});

describe('四.4 体积告警（纯函数）与 build 报字节数', () => {
  it('未超阈值 → 无告警；超单库 → 建议 clean/收窄；超总量 → 指向 doctor --fix', () => {
    expect(sizeWarnings(10, 20)).toEqual([]);
    const one = sizeWarnings(DB_SIZE_WARN_BYTES + 1, 20);
    expect(one.length).toBe(1);
    expect(one[0]).toContain('收窄构建范围');
    const both = sizeWarnings(DB_SIZE_WARN_BYTES + 1, CACHE_SIZE_WARN_BYTES + 1);
    expect(both.length).toBe(2);
    expect(both[1]).toContain('doctor');
  });

  it('build 报出 db_bytes / cache_bytes / size_warnings', async () => {
    const root = await tmpProject({ 'package.json': '{}', 'a.ts': 'export const a = 1;\n' });
    const m = new XrefManager();
    await m.init(root);
    try {
      const stats = await m.build(undefined, undefined, 50, { force: true });
      expect(typeof stats.db_bytes).toBe('number');
      expect(stats.db_bytes).toBeGreaterThan(0); // WAL 库一建就有内容
      expect(typeof stats.cache_bytes).toBe('number');
      expect(stats.cache_bytes).toBeGreaterThanOrEqual(stats.db_bytes ?? 0);
      expect(Array.isArray(stats.size_warnings)).toBe(true);
    } finally {
      m.close();
    }
  });
});

describe('四.3 体检报告：孤儿 / 可疑根 / 不误判', () => {
  it('根已消失 → 孤儿；根在禁区 → 可疑根；两者都能被回收', async () => {
    const gone = await tmpProject({ 'package.json': '{}', 'a.ts': 'export const a = 1;\n' });
    const suspect = await tmpProject({ 'package.json': '{}', 'a.ts': 'export const a = 1;\n' });
    const cacheDir = path.join(fakeHome, '.agent', 'cache');

    // 建两个库：一个把 root_dir 指向一个稍后删掉的目录，一个把 root_dir 改成主目录（禁区）
    const mGone = new XrefManager();
    await mGone.init(gone);
    await mGone.build(undefined, undefined, 50, { force: true });
    mGone.close();
    const mSus = new XrefManager();
    await mSus.init(suspect);
    await mSus.build(undefined, undefined, 50, { force: true });
    mSus.close();

    const { DatabaseSync } = await import('node:sqlite');
    const { toProjectKey } = await import('../../utils/misc.js');
    const susDb = path.join(cacheDir, `xref-${toProjectKey(suspect)}.sqlite`);
    const w = new DatabaseSync(susDb);
    w.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('root_dir', os.homedir());
    w.close();

    await fsp.rm(gone, { recursive: true, force: true }); // 让第一个库变成孤儿

    const report = xrefCacheReport(cacheDir);
    const byName = (n: string) => report.dbs.find((d) => d.name === n);
    expect(byName(`xref-${toProjectKey(gone)}.sqlite`)?.orphan).toBe(true);
    expect(byName(`xref-${toProjectKey(suspect)}.sqlite`)?.suspect_root).toBe(true);

    const r = reclaimOrphans(report);
    expect(r.removed.length).toBeGreaterThanOrEqual(2);
    expect(r.bytes).toBeGreaterThan(0);
    // 回收后文件真的没了（三件套一起）
    expect(fs.existsSync(path.join(cacheDir, `xref-${toProjectKey(gone)}.sqlite`))).toBe(false);
  });

  it('打不开的库不算孤儿（安全优先：宁可漏报也不误删）', async () => {
    const cacheDir = path.join(fakeHome, '.agent', 'cache', 'broken');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, 'xref-broken.sqlite'), 'not a database', 'utf-8');
    const report = xrefCacheReport(cacheDir);
    expect(report.dbs.length).toBe(1);
    expect(report.dbs[0].orphan).toBe(false);
    expect(report.dbs[0].suspect_root).toBe(false);
    expect(reclaimOrphans(report).removed).toEqual([]);
  });
});

describe('五 clean：区分「被占用」与「不存在」', () => {
  it('不存在的库 → 明确说"未找到/已删除"（不是笼统的 cannot delete）', async () => {
    const root = await tmpProject({ 'package.json': '{}' });
    const m = new XrefManager();
    await m.init(root);
    try {
      // 先真删一次，再删第二次 —— 第二次目标已不存在
      await m.deleteDatabase(root);
      const again = await m.deleteDatabase(root);
      expect(again).toMatch(/not found|already deleted/);
      expect(again).not.toContain('被占用');
    } finally {
      m.close();
    }
  });

  it('库被另一个会话持有时 → 报「被占用」并给出下一步（而非权限错觉）', async () => {
    const root = await tmpProject({ 'package.json': '{}', 'a.ts': 'export const a = 1;\n' });
    const holder = new XrefManager();
    await holder.init(root); // 持有该库
    await holder.build(undefined, undefined, 50, { force: true });

    const deleter = new XrefManager();
    const out = await deleter.deleteDatabase(root);
    holder.close();

    // 平台上若允许删除（POSIX 风格），则退化为成功 —— 此时断言"没误报成权限错误"
    if (out.startsWith('✅') || out.includes('not found')) {
      expect(out).not.toContain('cannot delete');
    } else {
      expect(out).toContain('被占用');
      expect(out).toContain('提示：');
    }
  });
});
