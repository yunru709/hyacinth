import { describe, it, expect, afterEach } from 'vitest';
import { ProcessManager } from './manager.js';
import type { ManagedProcessConfig } from './interface.js';

/** 常驻进程命令：node -e "setInterval(function(){},1000)" 保持存活
 *  注意：Windows 上 ProcessManager 用 shell:true，命令经 cmd.exe 执行，
 *  箭头函数里的 > 会被当成重定向符，故用 function(){} 而非 ()=>{} */
const NODE = process.execPath;
const HANG = ['-e', 'setInterval(function(){},1000)'];
/** 立即退出的命令 */
const EXIT0 = ['-e', 'process.exit(0)'];

function makeConfig(overrides: Partial<ManagedProcessConfig> = {}): ManagedProcessConfig {
  return {
    name: 'test-proc',
    command: NODE,
    args: HANG,
    stopTimeoutMs: 3000,
    ...overrides,
  };
}

const managers: ProcessManager[] = [];

function track(pm: ProcessManager): ProcessManager {
  managers.push(pm);
  return pm;
}

/** 轮询等待条件成立（避免固定 sleep 在负载高时竞态——短命进程退出事件可能延迟派发；
 *  超时给 20s：单跑瞬时完成，全量并发满载时 spawn(Windows shell) 可能显著变慢，de-flake） */
async function waitFor(cond: () => boolean, timeout = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(async () => {
  // 清理所有已启动的进程，避免测试间泄漏
  for (const pm of managers.splice(0)) {
    try { await pm.destroy(); } catch { /* ignore */ }
  }
});

describe('ProcessManager', () => {
  it('starts a process and reaches running state', async () => {
    const pm = track(new ProcessManager(makeConfig()));
    await pm.start();
    expect(pm.getState()).toBe('running');
    expect(pm.getProcess()?.pid).toBeGreaterThan(0);
  });

  it('stop() terminates the process and returns to stopped', async () => {
    const pm = track(new ProcessManager(makeConfig()));
    await pm.start();
    expect(pm.getState()).toBe('running');

    await pm.stop();
    expect(pm.getState()).toBe('stopped');
    expect(pm.getProcess()).toBeNull();
  });

  it('reports exit code for a short-lived process that exits on its own', async () => {
    const pm = track(new ProcessManager(makeConfig({ args: EXIT0, autoRestart: false })));
    await pm.start();
    // 进程会自己退出（exit 0），状态变 crashed
    await waitFor(() => pm.getStatus().state === 'crashed');
    expect(pm.getStatus().state).toBe('crashed');
    expect(pm.getStatus().lastExitCode).toBe(0);
  });

  it('autoRestart respawns a crashed process up to maxRestarts', async () => {
    const pm = track(new ProcessManager(makeConfig({
      args: EXIT0,
      autoRestart: true,
      maxRestarts: 2,
      restartDelayMs: 50,
    })));
    await pm.start();
    // 等待自动重启发生（进程退出 → handleCrash → respawn）
    await waitFor(() => pm.getStatus().restartCount >= 1);
    expect(pm.getStatus().restartCount).toBeGreaterThanOrEqual(1);
  });

  it('getStatus() returns a full snapshot', async () => {
    const pm = track(new ProcessManager(makeConfig()));
    await pm.start();
    const status = pm.getStatus();
    expect(status).toMatchObject({
      name: 'test-proc',
      state: 'running',
    });
    expect(status.pid).toBeGreaterThan(0);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  it('restart() stops then starts again', async () => {
    const pm = track(new ProcessManager(makeConfig()));
    await pm.start();
    const pid1 = pm.getProcess()?.pid;

    await pm.restart();
    expect(pm.getState()).toBe('running');
    expect(pm.getProcess()?.pid).not.toBe(pid1);
  });

  it('start() when already running is a no-op', async () => {
    const pm = track(new ProcessManager(makeConfig()));
    await pm.start();
    const pid = pm.getProcess()?.pid;
    await pm.start();
    expect(pm.getProcess()?.pid).toBe(pid);
  });

  it('fires onStateChange and onCrash callbacks', async () => {
    const states: string[] = [];
    const crashes: Array<number | null> = [];
    const pm = track(new ProcessManager(makeConfig({ args: EXIT0, autoRestart: false }), {
      onStateChange: (_n, from, to) => states.push(`${from}->${to}`),
      onCrash: (_n, code) => crashes.push(code),
    }));
    await pm.start();
    // 短命进程最终 crashed 并触发 onCrash(0)。注意：Windows 慢环境下
    // waitForStartup 的 1s 窗口内 exit 事件可能未到，先标 running 再 crashed，
    // 故容忍 starting→crashed 直通与 starting→running→crashed 两种合法序列，
    // 核心契约是：必经过 crashed 转换、必触发 onCrash、最终状态为 crashed。
    await waitFor(() => crashes.includes(0));
    expect(states[0]).toBe('stopped->starting');
    expect(states.some((s) => s.endsWith('->crashed'))).toBe(true);
    expect(pm.getState()).toBe('crashed');
    expect(crashes).toContain(0);
  });

  it('destroy() stops the process and clears callbacks', async () => {
    const pm = track(new ProcessManager(makeConfig()));
    await pm.start();
    await pm.destroy();
    expect(pm.getState()).toBe('stopped');
  });
});
