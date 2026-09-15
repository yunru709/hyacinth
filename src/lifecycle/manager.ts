import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createConnection } from 'node:net';
import http from 'node:http';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';
import { killProcessTreeSync, spawnWatchdog } from './watchdog.js';
import { registerManager, unregisterManager, installGlobalReaper } from './global-registry.js';

const logger = createLogger('process-manager');
import type {
  ManagedProcessConfig,
  ProcessState,
  ProcessStatus,
  ProcessEventCallbacks,
} from './interface.js';

const isWindows = os.platform() === 'win32';

/**
 * ProcessManager — 通用子进程生命周期管理器。
 *
 * 职责：
 *   - 启动/停止/重启子进程
 *   - 健康检查（HTTP / TCP）
 *   - 崩溃自动恢复
 *   - 超时强杀（SIGTERM → taskkill 回退）
 *   - 进程树清理（Windows taskkill /T，Unix kill -pid）
 *   - 状态追踪与事件通知
 */
export class ProcessManager {
  private proc: ChildProcess | null = null;
  private state: ProcessState = 'stopped';
  private startedAt: Date | null = null;
  private restartCount = 0;
  private lastExitCode: number | null = null;
  private lastError: string | null = null;

  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** 进行中的启动 Promise（幂等：starting 状态下再次 start 等待同一启动，不重复 spawn） */
  private startPromise: Promise<void> | null = null;
  private healthOk = false;
  private healthFailCount = 0;
  private manualStop = false;
  private childPids: Set<number> = new Set();

  constructor(
    public readonly config: ManagedProcessConfig,
    private callbacks?: ProcessEventCallbacks,
  ) {
    // 自动注册到全局注册表：无论本实例是否经过 LifecycleSupervisor，
    // 进程退出路径都会被收割（防裸实例孤儿化）
    registerManager(this);
    installGlobalReaper();
  }

  // ===== 公共 API =====

  /** 获取当前状态 */
  getState(): ProcessState {
    return this.state;
  }

  /** 获取当前进程实例 */
  getProcess(): ChildProcess | null {
    return this.proc;
  }

  /** 获取完整状态快照 */
  getStatus(): ProcessStatus {
    return {
      name: this.config.name,
      state: this.state,
      pid: this.proc?.pid ?? null,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : null,
      restartCount: this.restartCount,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      startedAt: this.startedAt?.toISOString() ?? null,
    };
  }

  /** 启动进程 + 等待健康检查通过（幂等：starting 时复用同一启动，避免重复 spawn） */
  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.state === 'starting' && this.startPromise) {
      return this.startPromise;
    }
    this.manualStop = false;
    this.transitionTo('starting');
    this.spawnProcess();
    const p = this.waitForStartup();
    this.startPromise = p;
    try {
      await p;
    } finally {
      if (this.startPromise === p) this.startPromise = null;
    }
  }

  /** 停止进程（优雅 → 强制进程树杀） */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.manualStop = true;
    this.transitionTo('stopping');
    this.stopHealthCheck();

    const pid = this.proc?.pid ?? null;

    if (!this.proc || pid === null) {
      this.proc = null;
      this.transitionTo('stopped');
      return;
    }

    const stopSignal = this.config.stopSignal ?? 'SIGTERM';
    const timeout = this.config.stopTimeoutMs ?? 10_000;

    try {
      if (isWindows) {
        // Windows 上必须「先树杀、再等退出」：shell:true 时 proc 是 cmd.exe
        // 外壳，直杀外壳（proc.kill 即 TerminateProcess）会让孙进程（真实工作
        // 进程）孤儿化——taskkill /T 依赖父链可走通，树根死了再补杀只会得到
        // status=128 而整体失败，这正是全量测试跑一次泄漏一批 node 孤儿进程
        // 的根源。趁树根存活时 taskkill /T /F 一次到位（Windows 无优雅终止，
        // SIGTERM 与 SIGKILL 等价）。
        this.killProcessTree(pid);
      } else if (stopSignal !== 'SIGKILL') {
        this.proc.kill(stopSignal);
      }

      await this.waitForExit(timeout);

      if (this.proc && this.proc.exitCode === null) {
        this.killProcessTree(pid);
      }
    } catch {
      this.killProcessTree(pid);
    }

    this.proc = null;
    this.transitionTo('stopped');
  }

  /**
   * 同步强制杀死进程及其所有子进程。
   * 用于进程退出事件（exit handler 中异步不可用）。
   */
  forceKill(): void {
    const pid = this.proc?.pid ?? null;
    if (pid === null) return;
    this.killProcessTree(pid);
    this.proc = null;
  }

  /** 重启进程 */
  async restart(): Promise<void> {
    await this.stop();
    this.restartCount = 0;
    this.lastError = null;
    await this.start();
  }

  /** 销毁管理器，清理所有资源 */
  async destroy(): Promise<void> {
    await this.stop();
    this.callbacks = undefined;
    // 从全局注册表注销：不再被退出收割器追踪
    unregisterManager(this);
  }

  /** 合并回调（公开接口） */
  setCallbacks(callbacks: ProcessEventCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  // ===== 内部方法 =====

  private spawnProcess(): void {
    if (this.proc) {
      try { this.proc.kill('SIGKILL'); } catch { /* 忽略 */ }
      this.proc = null;
    }

    const { command, args, env, cwd } = this.config;

    this.proc = spawn(command, args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
      cwd,
      // Windows 上 npx/npm 等 .cmd 命令需要 shell 模式才能执行
      shell: isWindows,
      windowsHide: true,
      detached: false,
    });

    this.startedAt = new Date();

    if (this.proc.pid) {
      this.childPids.add(this.proc.pid);
      // 父死自灭 watchdog：主进程被外部强杀（TerminateProcess，JS 钩子
      // 不触发）时由 watchdog 杀掉本进程树，防止孤儿化
      spawnWatchdog(this.proc.pid);
    }

    this.proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd();
      if (text) logger.debug(`[${this.config.name}] ${text}`);
    });
    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd();
      if (text) logger.warn(`[${this.config.name}] ${text}`);
    });

    this.proc.on('exit', (code, signal) => {
      if (this.proc?.pid) this.childPids.delete(this.proc.pid);
      this.lastExitCode = code;
      this.proc = null;
      this.stopHealthCheck();

      if (signal || this.manualStop) {
        if (!this.manualStop && this.state !== 'stopping') {
          this.handleCrash(code);
        }
        return;
      }

      if (code !== null && code !== 0) {
        this.handleCrash(code);
      } else if (code === 0 && !this.manualStop) {
        this.handleCrash(code);
      }
    });

    this.proc.on('error', (err) => {
      this.lastError = err.message;
      if (!this.manualStop) {
        this.handleCrash(null);
      }
    });
  }

  private handleCrash(exitCode: number | null): void {
    this.healthOk = false;
    this.transitionTo('crashed');
    this.callbacks?.onCrash?.(this.config.name, exitCode);

    if (this.manualStop) return;

    if (this.config.autoRestart && this.restartCount < (this.config.maxRestarts ?? 5)) {
      const delay = this.config.restartDelayMs ?? 2000;
      this.restartCount++;
      setTimeout(() => {
        if (!this.manualStop) {
          this.transitionTo('starting');
          this.spawnProcess();
          this.waitForStartup();
        }
      }, delay);
    }
  }

  private async waitForStartup(): Promise<void> {
    if (!this.config.healthCheck) {
      // 无健康检查：给进程一点时间启动，然后直接标记 running
      await sleep(1000);
      // 进程若在等待期间已退出（exit 事件已把状态置为 crashed），
      // 不得再覆盖为 running —— 否则短命进程会被误报为存活
      if (this.state !== 'stopping' && this.state !== 'crashed' && this.proc !== null) {
        this.transitionTo('running');
      }
      return;
    }

    const hc = this.config.healthCheck;
    const timeout = this.config.startupTimeoutMs ?? 60_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (this.manualStop || this.state === 'stopping') return;

      const ok = await this.performHealthCheck(hc);
      if (ok) {
        this.healthOk = true;
        this.healthFailCount = 0;
        this.startPeriodicHealthCheck(hc);
        this.transitionTo('running');
        return;
      }

      await sleep(hc.intervalMs ?? 2000);
    }

    // 启动超时
    this.lastError = `Startup health check timed out after ${timeout}ms`;
    this.transitionTo('failed');
    if (this.config.autoRestart) {
      this.handleCrash(null);
    }
  }

  private async performHealthCheck(hc: NonNullable<ManagedProcessConfig['healthCheck']>): Promise<boolean> {
    try {
      if (hc.url) {
        await httpGet(hc.url, hc.timeoutMs ?? 3000);
        return true;
      }
      if (hc.host && hc.port !== undefined) {
        await tcpConnect(hc.host, hc.port, hc.timeoutMs ?? 3000);
        return true;
      }
      return true; // 无健康检查方式
    } catch {
      return false;
    }
  }

  private startPeriodicHealthCheck(hc: NonNullable<ManagedProcessConfig['healthCheck']>): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(async () => {
      if (this.state !== 'running') return;

      const ok = await this.performHealthCheck(hc);
      if (ok) {
        if (!this.healthOk) {
          this.healthOk = true;
          this.healthFailCount = 0;
          this.callbacks?.onHealthRecover?.(this.config.name);
        }
        return;
      }

      this.healthFailCount++;
      if (this.healthFailCount >= (hc.maxRetries ?? 3)) {
        this.healthOk = false;
        this.lastError = `Health check failed after ${this.healthFailCount} attempts`;
        this.callbacks?.onHealthFail?.(this.config.name, this.lastError);
        this.handleCrash(this.lastExitCode);
      }
    }, hc.intervalMs ?? 5000);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) {
        resolve();
        return;
      }

      const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);

      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.proc.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * 杀死进程及其所有子进程（进程树）。
   * 统一走 lifecycle/watchdog.ts 的同步三级树杀
   * （taskkill → PowerShell KT 递归 → process.kill）。
   */
  private killProcessTree(pid: number): void {
    killProcessTreeSync(pid);
  }

  /**
   * 清理所有已知的子进程 PID。
   * 在 exit handler 中同步调用，不依赖异步操作。
   */
  forceKillAll(): void {
    for (const pid of this.childPids) {
      this.killProcessTree(pid);
    }
    this.childPids.clear();
  }

  private transitionTo(newState: ProcessState): void {
    const old = this.state;
    this.state = newState;
    this.callbacks?.onStateChange?.(this.config.name, old, newState);
  }
}

// ===== HTTP / TCP 健康检查工具 =====

function httpGet(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode < 500) {
        resolve();
      } else {
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, timeout: timeoutMs }, () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Timeout'));
    });
  });
}