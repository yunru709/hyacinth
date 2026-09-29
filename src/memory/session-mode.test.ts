/**
 * 会话的**模式归属** —— 分桶结构 · 列表过滤 · 归属判定（跨模式切换守卫的依据）。
 *
 * 用户定（2026-09-30）：会话与模式**一一归属** —— 普通模式只能切普通模式的会话、
 * 陪伴模式只能切陪伴模式的；于是三条规则：
 *   ① 列表**只列本模式**（`/命令`、WebUI、agent 工具同一处）
 *   ② 跨模式**强行切换 → 明确拒绝**（说清"属于 X 模式，当前是 Y"，不静默 ✗）
 *   ③ 判定不了 ⇒ **放行**（拦错比放行错更糟：会让人以为会话丢了）
 *
 * 本文件锁 ①②③ 依赖的两件事：分桶落盘（create/listByMode）与归属判定（sessionModeOfDir）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, sessionModeOfDir } from './session.js';

const created: string[] = [];

function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-mode-'));
  created.push(d);
  return path.join(d, 'sessions');
}

afterAll(() => {
  for (const d of created.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('会话按模式分桶 + 按模式过滤', () => {
  it('create(type) 落进该模式的桶；listByMode 只列本模式', async () => {
    const root = tmpRoot();
    const sm = new SessionManager(process.cwd(), root);

    const n = await sm.create('normal', 'tui');
    const c = await sm.create('companion', 'tui');
    const t = await sm.create('test', 'tui');

    expect(fs.existsSync(path.join(root, 'normal', n.id))).toBe(true);
    expect(fs.existsSync(path.join(root, 'companion', c.id))).toBe(true);
    expect(fs.existsSync(path.join(root, 'test', t.id))).toBe(true);

    expect((await sm.listByMode('normal')).map((s) => s.id)).toEqual([n.id]);
    expect((await sm.listByMode('test')).map((s) => s.id)).toEqual([t.id]);
    expect((await sm.list()).length, '全量列表仍应能看到全部（内部用，别删）').toBe(3);
  });

  it('sessionModeOfDir：桶内会话按 meta/桶名判定；判定不了 → null（守卫放行）', async () => {
    const root = tmpRoot();
    const sm = new SessionManager(process.cwd(), root);
    const c = await sm.create('companion', 'tui');

    expect(await sessionModeOfDir(sm.getSessionDir(c.id))).toBe('companion');
    // "说不清"必须是 null（而不是猜一个）—— 守卫据此放行 ✓
    expect(await sessionModeOfDir(path.join(os.tmpdir(), 'definitely-not-a-session-dir'))).toBeNull();
  });

  it('迁移：旧扁平会话归入各自模式桶；幂等，且不覆盖既有同名会话', async () => {
    const root = tmpRoot();
    const sm = new SessionManager(process.cwd(), root);

    const legacyId = 'tui_20260101-000000-abcd';
    const legacy = path.join(root, legacyId);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, 'meta.json'),
      JSON.stringify({ type: 'test', createdAt: new Date().toISOString() }),
      'utf-8',
    );

    const first = await sm.migrateLegacyLayout();
    expect(first.moved.length).toBe(1);
    expect(fs.existsSync(path.join(root, 'test', legacyId))).toBe(true);

    const second = await sm.migrateLegacyLayout();
    expect(second.moved.length, '第二次不该再动任何东西（幂等）').toBe(0);
  });
});
