/**
 * BackgroundProcessRegistry — 后台进程注册表
 *
 * 管理异步工具启动的后台子进程（如 dev server），提供统一的
 * 注册、查询、输出读取、终止和优雅关闭能力。
 *
 * 所有后台进程在会话结束时由 LifecycleSupervisor 统一清理。
 */
import { type ChildProcess } from 'node:child_process';
import { createLogger } from '../logging/logger.js';
import { killProcessTreeSync, spawnWatchdog } from '../lifecycle/watchdog.js';

const logger = createLogger('background-registry');

export interface BackgroundProcessInfo {
  handle: string;
  name: string;
  command: string;
  pid: number | null;
  status: 'running' | 'stopped' | 'crashed';
  startTime: string;
  outputSize: number;
}

interface BackgroundEntry {
  handle: string;
  name: string;
  command: string;
  childProcess: ChildProcess;
  outputBuffer: string[];
  maxOutputLines: number;
  startTime: Date;
}

let nextId = 1;

/** 杀死进程树（统一走 lifecycle/watchdog.ts 的同步三级树杀） */
function killProcessTree(pid: number): void {
  killProcessTreeSync(pid);
}

export class BackgroundProcessRegistry {
  private entries = new Map<string, BackgroundEntry>();

  /**
   * 注册一个后台子进程。生成唯一 handle 并开始捕获输出。
   * @param name 工具名称（如 'bash'）
   * @param command 原始命令（用于列表展示）
   * @param childProcess 已 spawn 的子进程
   * @returns handle 字符串（如 'bg_001'）
   */
  register(name: string, command: string, childProcess: ChildProcess): string {
    const handle = `bg_${String(nextId++).padStart(3, '0')}`;
    const entry: BackgroundEntry = {
      handle,
      name,
      command: command.length > 120 ? command.slice(0, 117) + '...' : command,
      childProcess,
      outputBuffer: [],
      maxOutputLines: 1000,
      startTime: new Date(),
    };

    // 捕获 stdout
    childProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (entry.outputBuffer.length >= entry.maxOutputLines) {
          entry.outputBuffer.shift();
        }
        entry.outputBuffer.push(line);
      }
    });

    // 捕获 stderr（混入 output）
    childProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (entry.outputBuffer.length >= entry.maxOutputLines) {
          entry.outputBuffer.shift();
        }
        entry.outputBuffer.push(`[stderr] ${line}`);
      }
    });

    // 进程退出时更新状态（进程保持 running 直到显式 kill）
    childProcess.on('exit', (code, signal) => {
      const existing = this.entries.get(handle);
      if (existing) {
        logger.debug(`Background process ${handle} (PID ${childProcess.pid}) exited: code=${code}, signal=${signal}`);
      }
    });

    // 父死自灭 watchdog：主进程被外部强杀时由 watchdog 杀掉本后台进程树
    if (childProcess.pid) {
      spawnWatchdog(childProcess.pid);
    }

    this.entries.set(handle, entry);
    logger.debug(`Registered background process ${handle}: ${command.slice(0, 80)}`);
    return handle;
  }

  /** 注销一个后台进程（进程已自然结束时从注册表移除，避免残留） */
  unregister(handle: string): boolean {
    const had = this.entries.delete(handle);
    if (had) logger.debug(`Unregistered background process ${handle}`);
    return had;
  }

  /** 获取进程状态 */
  getStatus(handle: string): BackgroundProcessInfo | null {
    const entry = this.entries.get(handle);
    if (!entry) return null;

    const exited = entry.childProcess.exitCode !== null;
    const killed = entry.childProcess.killed;

    let status: 'running' | 'stopped' | 'crashed' = 'running';
    if (killed) status = 'stopped';
    else if (exited && entry.childProcess.exitCode !== 0) status = 'crashed';
    else if (exited) status = 'stopped';

    return {
      handle: entry.handle,
      name: entry.name,
      command: entry.command,
      pid: entry.childProcess.pid ?? null,
      status,
      startTime: entry.startTime.toISOString(),
      outputSize: entry.outputBuffer.length,
    };
  }

  /** 获取进程输出 */
  getOutput(handle: string): string {
    const entry = this.entries.get(handle);
    if (!entry) return `No process found for handle: ${handle}`;
    if (entry.outputBuffer.length === 0) return '(no output yet)';
    return entry.outputBuffer.join('\n');
  }

  /** 列出所有后台进程 */
  list(): BackgroundProcessInfo[] {
    const results: BackgroundProcessInfo[] = [];
    for (const entry of this.entries.values()) {
      const info = this.getStatus(entry.handle);
      if (info) results.push(info);
    }
    return results;
  }

  /** 停止指定进程 */
  async kill(handle: string): Promise<boolean> {
    const entry = this.entries.get(handle);
    if (!entry) return false;

    const pid = entry.childProcess.pid;
    if (pid) {
      killProcessTree(pid);
    }
    this.entries.delete(handle);
    logger.debug(`Killed background process ${handle}`);
    return true;
  }

  /** 停止所有后台进程（异步，用于优雅关闭） */
  async shutdownAll(): Promise<void> {
    const handles = [...this.entries.keys()];
    for (const handle of handles) {
      await this.kill(handle);
    }
    logger.debug(`Shutdown all background processes (${handles.length} total)`);
  }

  /**
   * 同步强制杀死所有后台进程。
   * 用于 exit handler（不能依赖异步），OS 最后防线。
   */
  forceKillAll(): void {
    for (const entry of this.entries.values()) {
      const pid = entry.childProcess.pid;
      if (pid) {
        try { killProcessTree(pid); } catch { /* best effort */ }
      }
    }
    this.entries.clear();
  }
}
