import { describe, it, expect } from 'vitest';
import {
  resolveRestartAction,
  shouldStopRestarting,
  RESTART_WINDOW_MS,
  RESTART_WINDOW_MAX,
} from './guardian.js';
import {
  RESTART_EXIT_CODE,
  RESTART_AFTER_UPDATE_EXIT_CODE,
  RESTART_AFTER_PLUGIN_EXIT_CODE,
} from './protocol.js';

describe('guardian restart action resolution', () => {
  it('42 → 原样重启（restart / new 语义）', () => {
    expect(resolveRestartAction(RESTART_EXIT_CODE, null)).toBe('restart');
  });

  it('43 → 剥离参数重启（update 完成语义）', () => {
    expect(resolveRestartAction(RESTART_AFTER_UPDATE_EXIT_CODE, null)).toBe('restart-clean');
  });

  it('44 → 原样重启（插件热更新兜底语义）', () => {
    expect(resolveRestartAction(RESTART_AFTER_PLUGIN_EXIT_CODE, null)).toBe('restart');
  });

  it('其他退出码 → 透传退出', () => {
    expect(resolveRestartAction(0, null)).toBe('exit');
    expect(resolveRestartAction(1, null)).toBe('exit');
    expect(resolveRestartAction(130, null)).toBe('exit');
  });

  it('信号终止（code=null）→ 透传退出', () => {
    expect(resolveRestartAction(null, 'SIGINT')).toBe('exit');
    expect(resolveRestartAction(null, null)).toBe('exit');
  });
});

describe('guardian crash-loop protection（失控循环防护）', () => {
  const now = 1_000_000;

  it('窗口内次数 < 上限 → 继续拉起', () => {
    const times = Array.from({ length: RESTART_WINDOW_MAX - 1 }, (_, i) => now - i * 100);
    expect(shouldStopRestarting(times, now)).toBe(false);
  });

  it(`窗口内次数达上限（${RESTART_WINDOW_MAX}）→ 停止拉起`, () => {
    const times = Array.from({ length: RESTART_WINDOW_MAX }, (_, i) => now - i * 100);
    expect(shouldStopRestarting(times, now)).toBe(true);
  });

  it('重启都在窗口外（>60s 前）→ 继续拉起（正常间隔重启不受限）', () => {
    const times = Array.from({ length: RESTART_WINDOW_MAX + 3 }, (_, i) => now - RESTART_WINDOW_MS - i * 1000);
    expect(shouldStopRestarting(times, now)).toBe(false);
  });

  it('窗口外多次 + 窗口内少量 → 按窗口内计数', () => {
    const times = [
      ...Array.from({ length: 4 }, (_, i) => now - RESTART_WINDOW_MS - i * 1000), // 窗口外
      ...Array.from({ length: RESTART_WINDOW_MAX - 1 }, (_, i) => now - i * 100), // 窗口内 4 次
    ];
    expect(shouldStopRestarting(times, now)).toBe(false);
    times.push(now - 50); // 窗口内第 5 次
    expect(shouldStopRestarting(times, now)).toBe(true);
  });

  it('空历史 → 继续拉起', () => {
    expect(shouldStopRestarting([], now)).toBe(false);
  });
});
