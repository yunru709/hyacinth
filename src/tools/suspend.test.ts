/**
 * suspend 工具 · 条件解析与落盘/读回 单测
 *
 * 🔴 核心回归（2026-11-05 实测事故）：
 *    `kind:'time'` 的 afterMs 常被写在 `spec` 里 —— **工具 description 原文就是这么教的**
 *    （`{"kind":"time","spec":{"afterMs":600000}}`），但 `loop.armSuspendTimer` 只读
 *    **顶层** `until.afterMs`。取不到就掉进 `armSuspendWatch` 分支，而 WatchService 不支持
 *    'time'，那边 `start()` 抛错被 catch 吞掉 ⇒ 现象是「已挂起（等待：60 秒）」然后
 *    **永远不会醒**。修复方式：解析侧与读回侧都把 `spec.afterMs` 提升到顶层。
 *    下面这些用例守着"别再让它静默失效"。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSuspendUntil,
  saveSuspendState,
  loadSuspendState,
  clearSuspendState,
} from './suspend.js';

const tmpDirs: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'suspend-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('parseSuspendUntil', () => {
  it('顶层 afterMs 正常解析', () => {
    const r = parseSuspendUntil({ kind: 'time', afterMs: 60000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.until.afterMs).toBe(60000);
  });

  it('🔴 spec.afterMs 会被提升到顶层（2026-11-05 事故回归）', () => {
    const r = parseSuspendUntil({ kind: 'time', spec: { afterMs: 60000 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.until.afterMs).toBe(60000);          // 必须能拿到，否则 armSuspendTimer 走错分支
      expect(r.until.spec?.afterMs).toBe(60000);    // 原始字段保留，不破坏调用方语义
    }
  });

  it('顶层优先于 spec', () => {
    const r = parseSuspendUntil({ kind: 'time', afterMs: 1000, spec: { afterMs: 9999 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.until.afterMs).toBe(1000);
  });

  it('user 不带 spec 合法（合法静默）', () => {
    const r = parseSuspendUntil({ kind: 'user' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.until.spec).toBeUndefined();
  });

  it('user 带 spec 报错（模型在瞎填）', () => {
    const r = parseSuspendUntil({ kind: 'user', spec: { path: 'x' } });
    expect(r.ok).toBe(false);
  });

  it('缺 kind 报错', () => {
    expect(parseSuspendUntil({}).ok).toBe(false);
    expect(parseSuspendUntil(null).ok).toBe(false);
    expect(parseSuspendUntil('time').ok).toBe(false);
  });

  it('非法 afterMs（负数/0/NaN）被忽略而不是当成有效值', () => {
    for (const bad of [-1, 0, Number.NaN, Infinity]) {
      const r = parseSuspendUntil({ kind: 'file', spec: { path: 'x.ts' }, afterMs: bad });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.until.afterMs).toBeUndefined();
    }
  });
});

describe('saveSuspendState / loadSuspendState', () => {
  it('落盘后能读回', () => {
    const dir = tmpdir();
    expect(saveSuspendState(dir, { until: { kind: 'time', afterMs: 5000 }, note: 'x' })).toBe(true);
    const back = loadSuspendState(dir);
    expect(back?.until.kind).toBe('time');
    expect(back?.until.afterMs).toBe(5000);
    expect(back?.armedAt).toBeTruthy();
  });

  it('🔴 读回旧盘面：afterMs 在 spec 里也要被提升（重启恢复路径）', () => {
    const dir = tmpdir();
    // 直接写一份"历史格式"的文件（模拟修复前落盘的 suspend.json）
    fs.writeFileSync(
      path.join(dir, 'suspend.json'),
      JSON.stringify({
        until: { kind: 'time', spec: { afterMs: 60000 }, note: '旧格式' },
        note: '重启后应仍能唤醒',
        armedAt: new Date().toISOString(),
      }),
      'utf-8',
    );
    const back = loadSuspendState(dir);
    expect(back?.until.afterMs).toBe(60000); // restoreAutoMode 靠它决定定时还是按事件
  });

  it('文件不存在 / 损坏 → null（不抛）', () => {
    const dir = tmpdir();
    expect(loadSuspendState(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'suspend.json'), '{ 坏掉的 json', 'utf-8');
    expect(loadSuspendState(dir)).toBeNull();
  });

  it('clearSuspendState 幂等', () => {
    const dir = tmpdir();
    saveSuspendState(dir, { until: { kind: 'user' } });
    clearSuspendState(dir);
    expect(loadSuspendState(dir)).toBeNull();
    expect(() => clearSuspendState(dir)).not.toThrow();
  });
});
