/**
 * Guardian — 守护进程，自动重新拉起 Agent。
 *
 * 当 Agent 主进程以退出码 42 退出时（restart 工具触发），
 * 守护进程自动重新 spawn 子进程。
 */

import { spawn, type ChildProcess } from 'node:child_process';

const RESTART_EXIT_CODE = 42;

export function runGuardian(args: string[]): void {
  const node = process.execPath;
  const entry = process.argv[1]; // dist/index.js

  function start(): ChildProcess {
    const child = spawn(node, [entry, ...args], {
      stdio: 'inherit',
      env: { ...process.env, HYACINTH_GUARDIAN_CHILD: '1' },
    });
    child.on('exit', (code, signal) => {
      if (code === RESTART_EXIT_CODE) {
        process.stderr.write('[guardian] Restarting Agent...\n');
        start(); // 重新拉起
      } else {
        process.exit(code ?? (signal ? 1 : 0));
      }
    });
    return child;
  }

  start();
}
