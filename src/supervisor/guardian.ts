/**
 * Guardian — 守护进程，自动重新拉起 Agent（壳层方案 S1：自 gateway/ 迁入）。
 *
 * 当 Agent 主进程以下列退出码退出时，守护进程自动重新 spawn 子进程
 * （退出码语义单源定义于 ./protocol.ts）：
 * - 42：用户/Agent 触发 restart / new（原样重启，同一入口，标记文件改变行为）
 * - 43：更新完成（hyacinth update 成功后）→ 重新拉起**默认入口**，
 *       丢弃 update 子命令参数，直接进入 TUI。
 * - 44：插件热更新失败且无法回退（原样重启 —— 插件从磁盘重新发现装载）。
 * 其他退出码原样透传。
 */

import { spawn, type ChildProcess } from 'node:child_process';

import {
  RESTART_EXIT_CODE,
  RESTART_AFTER_UPDATE_EXIT_CODE,
  RESTART_AFTER_PLUGIN_EXIT_CODE,
  GUARDIAN_ENV,
} from './protocol.js';

export type RestartAction = 'restart' | 'restart-clean' | 'exit';

/**
 * 解析子进程退出信号 → 守护动作：
 * - 42 → 'restart'：原样重启（restart / new 语义）
 * - 43 → 'restart-clean'：剥离子命令参数重启（update 完成）
 * - 44 → 'restart'：原样重启（插件变更，重启后从磁盘重新装载）
 * - 其他 → 'exit'：透传退出码
 */
export function resolveRestartAction(
  code: number | null,
  signal: NodeJS.Signals | null,
): RestartAction {
  if (code === RESTART_EXIT_CODE || code === RESTART_AFTER_PLUGIN_EXIT_CODE) return 'restart';
  if (code === RESTART_AFTER_UPDATE_EXIT_CODE) return 'restart-clean';
  return 'exit';
}

// ─── 失控循环防护（crash-loop protection） ──────────────────────────

/** 重启节流窗口（ms）：滑动窗口内计数 */
export const RESTART_WINDOW_MS = 60_000;
/** 窗口内最大 guardian 拉起次数，超过判定为失控循环（对齐 systemd StartLimitBurst 语义） */
export const RESTART_WINDOW_MAX = 5;

/**
 * 是否应停止拉起：滑动窗口内（now-RESTART_WINDOW_MS, now] 的重启次数已达上限。
 *
 * 判定对象是「guardian 主动拉起」事件（42/43/44 皆计）——正常使用（人工 restart、
 * 更新、插件兜底）远达不到该频率；连续超限只可能是启动即触发重启的失控循环，
 * 继续拉起只会打转，停止并留给用户排查。
 * 纯函数便于单测；runGuardian 持有重启时间戳序列逐次调用。
 */
export function shouldStopRestarting(restartTimes: number[], now: number): boolean {
  let inWindow = 0;
  for (let i = restartTimes.length - 1; i >= 0; i--) {
    if (now - restartTimes[i]! >= RESTART_WINDOW_MS) break; // 时间戳单调递增，可提前终止
    inWindow++;
  }
  return inWindow >= RESTART_WINDOW_MAX;
}

export function runGuardian(args: string[]): void {
  const node = process.execPath;
  const entry = process.argv[1]; // dist/index.js
  /** guardian 主动拉起的时间戳序列（失控循环检测输入） */
  const restartTimes: number[] = [];

  function start(extraArgs: string[] = args): ChildProcess {
    const child = spawn(node, [entry, ...extraArgs], {
      stdio: 'inherit',
      env: { ...process.env, [GUARDIAN_ENV]: '1' },
    });
    child.on('exit', (code, signal) => {
      const action = resolveRestartAction(code, signal);
      if (action === 'restart' || action === 'restart-clean') {
        const now = Date.now();
        restartTimes.push(now);
        if (shouldStopRestarting(restartTimes, now)) {
          process.stderr.write(
            `[guardian] ${RESTART_WINDOW_MS / 1000}s 内已重启 ${RESTART_WINDOW_MAX} 次，判定为失控循环，停止拉起。\n` +
            '[guardian] 请查看日志排查原因（如插件/配置损坏导致启动即触发重启）。\n',
          );
          process.exit(1);
          return;
        }
        if (action === 'restart') {
          process.stderr.write('[guardian] Restarting Agent...\n');
          start(); // 原样重启（restart / new / 插件变更兜底）
        } else {
          process.stderr.write('[guardian] Update finished — starting Agent...\n');
          start([]); // 更新完成 → 默认入口（剥离 update 子命令参数）
        }
      } else {
        process.exit(code ?? (signal ? 1 : 0));
      }
    });
    return child;
  }

  start();
}
