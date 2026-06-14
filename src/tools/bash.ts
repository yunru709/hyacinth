import { spawn, execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { Tool } from './interface.js';
import type { BackgroundProcessRegistry } from './background-registry.js';

/** 沙箱配置接口 — 限制 BashTool 可执行的命令 */
export interface SandboxConfig {
  /** 允许访问的目录白名单（默认: [cwd]） */
  allowedPaths: string[];
  /** 危险命令黑名单（大小写不敏感子串匹配） */
  blockedCommands: string[];
  /** 最大输出字节数，默认 1MB */
  maxOutputBytes?: number;
}

/** 默认的危险命令黑名单（子串匹配） */
const DEFAULT_BLOCKED_COMMANDS: string[] = [
  'rm -rf /',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',
  'del /f /s /q C:',
];

/** 词边界正则黑名单 — 匹配独立危险命令，避免子串误杀（如 format 误杀 Format-Table） */
const BLOCKED_COMMAND_REGEX: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bformat\b/i, label: 'format' },
];

/** Platform-aware default shell */
function getShell(): string {
  if (os.platform() === 'win32') {
    return 'powershell.exe';
  }
  return '/bin/sh';
}

/**
 * BashTool — 在子进程中执行命令
 *
 * 参数：
 * - command (必需): 要执行的命令
 * - timeout (可选): 超时时间（秒），默认 600
 * - env (可选): 环境变量映射，会自动持久化到后续调用
 *
 * 平台适配：
 * - Windows: 使用 PowerShell 执行，默认注入 PYTHONIOENCODING=utf-8 + PYTHONUTF8=1
 * - Linux/macOS: 使用 /bin/sh 执行
 *
 * 返回 stdout + stderr，超时后终止进程树
 * 工作目录为当前 Agent 的工作目录
 */
export class BashTool implements Tool {
  readonly name = 'bash';
  readonly description =
    'Executes a command in a subprocess and returns stdout and stderr. On Windows uses PowerShell, on Linux/macOS uses /bin/sh. Supports timeout control (default 600 seconds). The working directory is the current Agent working directory. ' +
    'Set "async": true to run the command as a background process — returns a handle immediately (e.g. "[background:bg_001]") and the process keeps running across turns. ' +
    'Use process_list / process_output / process_kill to manage background processes.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds. Default is 600. Ignored when async=true.',
      },
      env: {
        type: 'object',
        description: 'Environment variables to set for this command. These persist across subsequent bash calls in this session. Example: {"PYTHONIOENCODING": "utf-8"}',
      },
      async: {
        type: 'boolean',
        description: 'If true, run the command as a background process. Returns a handle immediately (e.g. [background:bg_001]). The process continues running and can be managed with process_list/process_output/process_kill.',
      },
    },
    required: ['command'],
  };
  readonly executionMode = 'asyncable';

  private cwd: string;
  private sandboxConfig: SandboxConfig;
  private persistentEnv: Record<string, string>;
  private backgroundRegistry?: BackgroundProcessRegistry;
  private allowAsync = true;

  constructor(cwd?: string, sandboxConfig?: SandboxConfig) {
    this.cwd = cwd ?? process.cwd();
    this.sandboxConfig = sandboxConfig ?? {
      allowedPaths: [this.cwd],
      blockedCommands: DEFAULT_BLOCKED_COMMANDS,
    };
    this.persistentEnv = {};
  }

  /** 更新工作目录 */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** 运行时更新沙箱配置 */
  setSandboxConfig(config: SandboxConfig): void {
    this.sandboxConfig = config;
  }

  /** 注入后台进程注册表（用于 async 模式） */
  setBackgroundRegistry(registry: BackgroundProcessRegistry): void {
    this.backgroundRegistry = registry;
  }

  /** 是否允许 async 模式（默认 true，可通过 tools.allowAsync 配置关闭） */
  setAllowAsync(allow: boolean): void {
    this.allowAsync = allow;
  }

  /** 获取当前沙箱配置（只读） */
  getSandboxConfig(): Readonly<SandboxConfig> {
    return this.sandboxConfig;
  }

  /**
   * 杀死进程树
   * - Windows: 使用 taskkill /T /F /PID
   * - Unix: 使用 process.kill(-pid) 杀进程组
   */
  private killProcessTree(pid: number): void {
    try {
      if (process.platform === 'win32') {
        // Windows: 使用 taskkill 杀进程树
        execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
      } else {
        // Unix: 杀进程组
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      // 进程可能已退出，尝试直接杀
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 进程已退出，忽略
      }
    }
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const command = args.command as string;
    if (!command) return '错误：缺少 command 参数。请提供要执行的命令。';
    const timeout = (args.timeout as number | undefined) ?? 600;
    const callEnv = (args.env as Record<string, string>) ?? {};
    const runAsync = args.async === true;

    // 持久化本次调用指定的环境变量
    for (const [key, value] of Object.entries(callEnv)) {
      this.persistentEnv[key] = value;
    }

    // 沙箱拦截：检查危险命令黑名单（子串匹配）
    const commandLower = command.toLowerCase();
    for (const blocked of this.sandboxConfig.blockedCommands) {
      if (commandLower.includes(blocked.toLowerCase())) {
        throw new Error(`Command blocked by sandbox: contains blocked pattern "${blocked}"`);
      }
    }

    // 沙箱拦截：词边界正则匹配（避免子串误杀）
    for (const { pattern, label } of BLOCKED_COMMAND_REGEX) {
      if (pattern.test(command)) {
        throw new Error(`Command blocked by sandbox: contains blocked command "${label}"`);
      }
    }

    // 沙箱拦截：检查 cd 命令的目标路径
    if (this.sandboxConfig.allowedPaths.length > 0) {
      const cdMatch = commandLower.match(/(?:^|\s|&&|\|{1,2}|;)\s*cd\s+([^\s;&|]+)/);
      if (cdMatch) {
        const targetPath = path.resolve(this.cwd, cdMatch[1]);
        const isAllowed = this.sandboxConfig.allowedPaths.some(
          (allowed) => targetPath.startsWith(path.resolve(allowed)),
        );
        if (!isAllowed) {
          return `Error: Directory "${cdMatch[1]}" is outside allowed paths. Blocked by sandbox.`;
        }
      }
    }

    // 沙箱拦截：检查路径是否在白名单内
    // 解析命令中可能包含的路径参数，验证工作目录是否在 allowedPaths 内
    if (this.sandboxConfig.allowedPaths.length > 0) {
      const cwdAllowed = this.sandboxConfig.allowedPaths.some(
        (p) => this.cwd === p || this.cwd.startsWith(p + (os.platform() === 'win32' ? '\\' : '/')),
      );
      if (!cwdAllowed) {
        throw new Error(
          `Command blocked by sandbox: working directory "${this.cwd}" is not in allowed paths`,
        );
      }
    }

    // ── 异步执行路径 ──
    if (runAsync) {
      if (!this.allowAsync) {
        return 'Error: Async execution is disabled (tools.allowAsync = false). Run the command synchronously by omitting the "async" parameter.';
      }
      if (!this.backgroundRegistry) {
        return 'Error: BackgroundProcessRegistry not available. Cannot run async commands.';
      }

      const shell = getShell();
      const isWin = process.platform === 'win32';

      const mergedEnv: Record<string, string | undefined> = { ...process.env };
      if (isWin) {
        mergedEnv.PYTHONIOENCODING = mergedEnv.PYTHONIOENCODING ?? 'utf-8';
        mergedEnv.PYTHONUTF8 = mergedEnv.PYTHONUTF8 ?? '1';
      }
      for (const [key, value] of Object.entries(this.persistentEnv)) {
        mergedEnv[key] = value;
      }

      const childProcess = spawn(command, [], {
        cwd: this.cwd,
        shell,
        env: mergedEnv,
        detached: !isWin,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 不等待，立即注册
      const handle = this.backgroundRegistry.register('bash', command, childProcess);
      const pid = childProcess.pid ?? '?';
      return `[background:${handle}] PID ${pid}\nCommand: ${command}\n\nUse process_output("${handle}") to read output, process_kill("${handle}") to stop.`;
    }

    // ── 同步执行路径（原有逻辑）──

    // 输出截断配置
    const MAX_OUTPUT_BYTES = this.sandboxConfig.maxOutputBytes ?? 15 * 1024; // 15KB
    let outputSize = 0;
    let truncated = false;

    return new Promise<string>((resolve, reject) => {
      const shell = getShell();
      const isWin = process.platform === 'win32';
      const startTime = Date.now();

      // 构建环境变量：Node 进程 env + 默认 UTF-8 + 持久化 env
      const mergedEnv: Record<string, string | undefined> = { ...process.env };
      if (isWin) {
        mergedEnv.PYTHONIOENCODING = mergedEnv.PYTHONIOENCODING ?? 'utf-8';
        mergedEnv.PYTHONUTF8 = mergedEnv.PYTHONUTF8 ?? '1';
      }
      for (const [key, value] of Object.entries(this.persistentEnv)) {
        mergedEnv[key] = value;
      }

      const childProcess = spawn(command, [], {
        cwd: this.cwd,
        shell: shell,
        env: mergedEnv,
        detached: !isWin, // Unix 使用进程组
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      // 收集 stdout，检查输出大小
      childProcess.stdout!.on('data', (data: Buffer | string) => {
        const chunk = Buffer.from(data);
        outputSize += chunk.length;
        if (outputSize <= MAX_OUTPUT_BYTES) {
          stdout += chunk.toString();
        } else if (!truncated) {
          truncated = true;
          stdout += '\n\n[Output truncated: exceeded 1MB limit]';
        }
      });

      // 收集 stderr，检查输出大小
      childProcess.stderr!.on('data', (data: Buffer | string) => {
        const chunk = Buffer.from(data);
        outputSize += chunk.length;
        if (outputSize <= MAX_OUTPUT_BYTES) {
          stderr += chunk.toString();
        } else if (!truncated) {
          truncated = true;
          stderr += '\n\n[Output truncated: exceeded 1MB limit]';
        }
      });

      // 超时处理：使用进程树 kill
      const timer = setTimeout(() => {
        if (childProcess.pid) {
          this.killProcessTree(childProcess.pid);
        }
      }, timeout * 1000);

      // AbortSignal 监听：Ctrl+C 中断时 kill 子进程
      const onAbort = () => {
        if (childProcess.pid) {
          this.killProcessTree(childProcess.pid);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      childProcess.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);

        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(stderr);

        if (truncated) {
          parts.push('[Output truncated: exceeded 1MB limit]');
        }

        const output = parts.join('\n');

        if (code === 0) {
          const elapsed = Date.now() - startTime;
          if (output) {
            resolve(output + `\n[Exit code: 0, ${elapsed}ms]`);
          } else {
            resolve(`Command completed successfully [Exit code: 0, ${elapsed}ms]`);
          }
        } else {
          // 检查是否因超时被杀
          const elapsed = Date.now() - startTime;
          const timedOut = code === null;
          if (timedOut) {
            parts.push(`[Process timed out after ${timeout} seconds, ${elapsed}ms]`);
          } else {
            parts.push(`[Exit code: ${code}, ${elapsed}ms]`);
          }
          const errOutput = parts.join('\n');
          if (errOutput) {
            reject(new Error(errOutput));
          } else {
            reject(new Error(`Command failed with exit code ${code}`));
          }
        }
      });

      childProcess.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Command failed: ${err.message}`));
      });

      // 关闭 stdin
      childProcess.stdin!.end();
    });
  }
}
