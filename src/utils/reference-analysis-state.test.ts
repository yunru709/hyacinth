/**
 * reference-analysis-state.test.ts — 运行态快照与 links 段渲染（Phase 6 第 3 步）
 *
 * 判据：
 *  ① 快照往返：写进去读得回（形状完整）；
 *  ② **坏掉/不存在一律返回 null**（诊断通道的自故障不得影响任何调用方）；
 *  ③ links 段的**三态渲染**都要看得出来 —— 尤其验收线点名的
 *     「xref 未挂载时必须显示"能力未注册（走核心兜底）"，不是留白」；
 *  ④ 快照可能来自**上一个进程** ⇒ 文本里必须带时间与 pid（不假装是"此刻"）。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSnapshot, writeSnapshot, formatLinksSection, snapshotPath } from './reference-analysis-state.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  realHome = os.homedir();
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'refstate-'));
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterAll(() => {
  homedirSpy.mockRestore();
  expect(os.homedir()).toBe(realHome);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('运行态快照', () => {
  it('① 往返：写入的字段读得回，且带上 updatedAt/pid', () => {
    writeSnapshot({
      provider: 'xref',
      registered: true,
      calls: 7,
      fallbacks: 2,
      lastReason: '索引陈旧',
      lastAt: '2026-09-19T02:00:00.000Z',
      lastSymbols: ['useIt'],
      lastOutput: '[References] …',
    });
    const s = readSnapshot();
    expect(s?.calls).toBe(7);
    expect(s?.fallbacks).toBe(2);
    expect(s?.lastReason).toBe('索引陈旧');
    expect(s?.lastSymbols).toEqual(['useIt']);
    expect(s?.updatedAt).toBeTruthy();
    expect(s?.pid).toBe(process.pid);
  });

  it('② 不存在 → null；内容坏掉 → null；形状不对 → null（绝不抛）', () => {
    fs.rmSync(snapshotPath(), { force: true });
    expect(readSnapshot()).toBeNull();

    fs.writeFileSync(snapshotPath(), '{ 这不是 JSON', 'utf8');
    expect(readSnapshot()).toBeNull();

    fs.writeFileSync(snapshotPath(), JSON.stringify({ provider: 'xref' }), 'utf8'); // 缺 calls
    expect(readSnapshot()).toBeNull();
  });
});

describe('links 段渲染（formatLinksSection，纯函数）', () => {
  it('③ 无快照 → 明确写出"能力未注册（走核心兜底）"（验收线：不是留白）', () => {
    const out = formatLinksSection(null, false);
    expect(out).toContain('── 联动（links）──');
    expect(out).toContain('引用自检（核心后置序列，始终启用');
    expect(out).toContain('能力未注册（走核心兜底）');
    expect(out).toContain('xref 插件已禁用');
  });

  it('③ 有快照且已注册 → 显示计数与最近原因（最有诊断价值的一格）', () => {
    const out = formatLinksSection(
      {
        provider: 'xref',
        registered: true,
        calls: 12,
        fallbacks: 3,
        lastReason: '索引陈旧',
        lastAt: '2026-09-19T02:00:00.000Z',
        lastSymbols: ['useIt', 'other'],
        lastOutput: 'x',
        updatedAt: '2026-09-19T02:00:01.000Z',
        pid: 1,
      },
      true,
    );
    expect(out).toContain('calls=12 fallbacks=3');
    expect(out).toContain('最近原因="索引陈旧"');
    expect(out).toContain('最近符号：useIt, other');
    expect(out).toContain('xref 插件已启用');
  });

  it('④ 快照带时间与 pid，并标明是否当前进程（不假装是"此刻"）', () => {
    const out = formatLinksSection(
      {
        provider: 'xref',
        registered: true,
        calls: 1,
        fallbacks: 0,
        lastReason: '',
        lastAt: '',
        lastSymbols: [],
        lastOutput: '',
        updatedAt: '2026-09-19T02:00:01.000Z',
        pid: process.pid,
      },
      null,
    );
    expect(out).toContain('2026-09-19T02:00:01.000Z');
    expect(out).toContain(`pid=${process.pid}`);
    expect(out).toContain('即当前进程');
    expect(out).toContain('xref 插件状态未知'); // 不猜
  });
});
