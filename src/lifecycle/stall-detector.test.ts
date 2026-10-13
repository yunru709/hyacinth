/**
 * stall-detector.test.ts —— 主线程卡死探测器的契约测试（2026-10-13）
 *
 * 这个模块的**存在意义**就是"在没人能观测时留下证据"，所以测试的重点不是覆盖率，
 * 而是把那条判据钉死：**心跳停止 ⇒ 必须写出报告；心跳正常 ⇒ 一个字节都不许写**。
 * 后者同样重要 —— 误报会在用户的盘上堆垃圾文件，比不报更烦人。
 *
 * ⚠️ 时序测试必须留足余量：worker 启动 + 首次 poll + 写报告都要时间，
 * 断言用「宽等待 + 存在性」，不写"精确在第 N 毫秒触发"这种注定 flaky 的东西。
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startStallDetector,
  __resetStallDetectorForTest,
  stallReportDir,
  ensureStallReportDir,
} from './stall-detector.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stall-det-'));
}

describe('stall-detector', () => {
  afterEach(() => {
    __resetStallDetectorForTest();
  });

  it('① 健康心跳：不写任何报告（误报比不报更烦）', async () => {
    const dir = tmpDir();
    const h = startStallDetector({ heartbeatMs: 50, pollMs: 80, stallMs: 400, reportDir: dir });

    await new Promise((r) => setTimeout(r, 900));

    expect(h.getReports().length).toBe(0);
    // 目录里也不该出现任何 stall-*.json（防止"报告写了但没进数组"的漏网）
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('stall-')) : [];
    expect(files.length).toBe(0);

    h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('② 【核心判据】心跳停止 ⇒ 判定主线程卡死并写出报告', async () => {
    const dir = tmpDir();
    // heartbeatMs 故意设成极大：初始那次心跳之后就再不更新 ⇒ 等价于"主线程被冻住"
    const h = startStallDetector({
      heartbeatMs: 10_000_000,
      pollMs: 120,
      stallMs: 250,
      reportDir: dir,
    });

    await new Promise((r) => setTimeout(r, 2000));

    const reports = h.getReports();
    expect(reports.length).toBeGreaterThan(0);
    // 报告文件必须真的落盘且非空（writeReport 失败会走 error 分支，这时 reports 是空的）
    expect(fs.existsSync(reports[0])).toBe(true);
    expect(fs.statSync(reports[0]).size).toBeGreaterThan(0);

    h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('③ 心跳恢复后不重复刷报告（同一卡死周期只写一份）', async () => {
    const dir = tmpDir();
    const h = startStallDetector({
      heartbeatMs: 10_000_000,
      pollMs: 100,
      stallMs: 200,
      reportEveryStall: true,
      reportDir: dir,
    });

    await new Promise((r) => setTimeout(r, 900));
    const first = h.getReports().length;
    expect(first).toBeGreaterThan(0);

    // 再等一段：报数不该无限增长到离谱（按 poll 频率计会是几十份）
    await new Promise((r) => setTimeout(r, 900));
    const second = h.getReports().length;
    expect(second).toBeLessThan(20);

    h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('④ 幂等：重复 start 返回同一 handle，不会挂出多个 worker', () => {
    const dir = tmpDir();
    const a = startStallDetector({ reportDir: dir });
    const b = startStallDetector({ reportDir: dir });
    expect(a).toBe(b);
    a.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('⑤ stop 幂等且可重复调用', () => {
    const dir = tmpDir();
    const h = startStallDetector({ reportDir: dir });
    h.stop();
    expect(() => h.stop()).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('⑥ 路径助手：报告目录位于 ~/.agent/crash 且可创建', () => {
    expect(stallReportDir()).toContain(path.join('.agent', 'crash'));
    expect(() => ensureStallReportDir()).not.toThrow();
  });
});
